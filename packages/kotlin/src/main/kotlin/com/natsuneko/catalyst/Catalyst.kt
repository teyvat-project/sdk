package com.natsuneko.catalyst

import com.natsuneko.catalyst.api.ApiAuth
import com.natsuneko.catalyst.api.ApiClient
import com.natsuneko.catalyst.api.ApiClientOptions
import com.natsuneko.catalyst.api.core.Retry401Middleware
import com.natsuneko.catalyst.api.core.TokenValue
import com.natsuneko.catalyst.api.core.UserAgentMiddleware
import com.natsuneko.catalyst.auth.OAuthClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/** Catalyst API client: the generated [api] client plus OAuth helpers and automatic token refresh on 401. */
public class Catalyst(options: CatalystOptions) : AutoCloseable {
    private val credentialLock = Any()
    private val refreshGate = Mutex()
    private val onTokenRefreshed: (suspend (Token) -> Unit)? = options.onTokenRefreshed

    // The shared refresh runs outside any caller, so a cancelled caller only stops waiting.
    private val refreshScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private var currentAccessToken: String? = options.accessToken
    private var currentRefreshToken: String? = options.refreshToken
    private var inflightRefresh: Deferred<Token>? = null // guarded by refreshGate

    /** Token requests and OAuth helpers. */
    public val oauth: OAuthClient = OAuthClient(options.clientId, options.clientSecret, options.baseUrl, httpClient = options.httpClient)

    /** The generated API client. */
    public val api: ApiClient = ApiClient(ApiClientOptions().apply {
        baseUrl = options.baseUrl
        httpClient = options.httpClient
        middleware.addAll(options.middleware)
        middleware.add(UserAgentMiddleware(USER_AGENT))
        middleware.add(Retry401Middleware { _, _ -> onUnauthorized() })
    })

    init {
        applyAuth()
    }

    public val accessToken: String?
        get() = synchronized(credentialLock) { currentAccessToken }

    public val refreshToken: String?
        get() = synchronized(credentialLock) { currentRefreshToken }

    /** Replaces the credentials; a `null` refresh token clears the stored one. */
    public fun setCredential(accessToken: String, refreshToken: String? = null) {
        synchronized(credentialLock) {
            currentAccessToken = accessToken
            currentRefreshToken = refreshToken
            applyAuth()
        }
    }

    public fun clearCredential() {
        synchronized(credentialLock) {
            currentAccessToken = null
            currentRefreshToken = null
            applyAuth()
        }
    }

    /**
     * Exchanges the refresh token for new credentials. Concurrent calls share a single request. Cancelling the caller
     * only stops it from waiting; the shared request keeps running for the other callers.
     *
     * @throws IllegalStateException No refresh token is available.
     */
    public suspend fun refresh(): Token {
        val refresh = refreshGate.withLock {
            inflightRefresh ?: refreshScope.async { runRefresh() }.also { inflightRefresh = it }
        }
        return refresh.await()
    }

    override fun close() {
        refreshScope.cancel()
        api.close()
        oauth.close()
    }

    private suspend fun runRefresh(): Token {
        try {
            return performRefresh()
        } finally {
            // The creator holds the gate until inflightRefresh is assigned, so this cannot run (and clear it) too early.
            withContext(NonCancellable) { refreshGate.withLock { inflightRefresh = null } }
        }
    }

    private suspend fun performRefresh(): Token {
        val refreshToken = refreshToken
        check(!refreshToken.isNullOrEmpty()) { "No refresh token is available" }

        val token = oauth.getAccessTokenByRefreshToken(refreshToken)
        setCredential(token.accessToken, token.refreshToken)
        onTokenRefreshed?.invoke(token)
        return token
    }

    /** Backs [Retry401Middleware]: refreshes once and asks for a replay, or gives up and lets the 401 through. */
    private suspend fun onUnauthorized(): Boolean {
        if (refreshToken.isNullOrEmpty()) return false
        return try {
            refresh()
            true
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            false
        }
    }

    /**
     * The generated runtime reads `options.auth` on every send (replays included), so replacing it is enough for a
     * replay after a 401 to carry the new token. An empty token means no auth at all: the runtime then fails with
     * `ApiAuthException` before sending, rather than sending an empty bearer header.
     */
    private fun applyAuth() {
        val token = currentAccessToken
        api.options.auth = if (token.isNullOrEmpty()) null else ApiAuth(bearerAuth = TokenValue(token))
    }
}
