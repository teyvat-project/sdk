// Licensed under the MIT License
//
// Copyright (c) 2025 Natsune Mochizuki

package com.natsuneko.catalyst.auth

import com.natsuneko.catalyst.PUBLIC_API_ENDPOINT
import com.natsuneko.catalyst.PUBLIC_AUTHORIZE_ENDPOINT
import com.natsuneko.catalyst.Token
import io.ktor.client.HttpClient
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsBytes
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import kotlin.math.abs
import kotlin.math.floor

public enum class OAuthErrorKind {
    /** The authorization server answered the callback with an `error` parameter. */
    AuthorizationRequestFailed,

    /** The callback URL does not match the expected redirect URI / state, or carries no `code`. */
    InvalidAuthorizationResponse,

    /** The token endpoint answered with a non-2xx status or a body that is not a token response. */
    InvalidTokenResponse,
}

public class OAuthException(
    message: String,
    public val kind: OAuthErrorKind,
    /** The OAuth `error` code: the `error` parameter of a failed authorization request, or the `error` of a failed token response (e.g. `invalid_grant`). */
    public val error: String? = null,
    public val errorDescription: String? = null,
    public val errorUri: String? = null,
) : Exception(message)

/**
 * OAuth 2.0 client for Catalyst authentication.
 *
 * @param clientId The OAuth client ID.
 * @param clientSecret The OAuth client secret.
 * @param baseUrl Base URL of the API; the token endpoint is `<baseUrl>/token`.
 * @param authorizeEndpoint Authorization endpoint used by [getAuthorizeUrl]; must be an absolute URL.
 * @param httpClient Sends the token requests (default: a client with the engine found on the classpath). It is not
 *   closed by [close], and redirects are not followed for the requests made here.
 */
public class OAuthClient(
    private val clientId: String,
    private val clientSecret: String,
    baseUrl: String = PUBLIC_API_ENDPOINT,
    private val authorizeEndpoint: String = PUBLIC_AUTHORIZE_ENDPOINT,
    httpClient: HttpClient? = null,
) : AutoCloseable {
    private val baseUrl: String = baseUrl.trimEnd('/')

    // Token requests deliberately bypass the API client's middleware chain (no Authorization, no 401 retry).
    private val http: Lazy<HttpClient> = lazy {
        val configure: io.ktor.client.HttpClientConfig<*>.() -> Unit = {
            followRedirects = false
            expectSuccess = false
        }
        httpClient?.config(configure) ?: HttpClient(configure)
    }

    init {
        require(authorizeEndpoint.contains("://")) { "authorizeEndpoint must be an absolute URL." }
    }

    /** Builds the URL to send the user to for authorization. */
    public fun getAuthorizeUrl(redirectUri: String, pkce: Pkce, state: String): String {
        val query = formEncode(
            listOf(
                "response_type" to "code",
                "client_id" to clientId,
                "redirect_uri" to redirectUri,
                "state" to state,
                "code_challenge" to pkce.challenge,
                "code_challenge_method" to pkce.method,
            ),
        )
        return "${authorizeEndpoint.substringBefore('?').substringBefore('#')}?$query"
    }

    /**
     * Validates the callback URL and returns its authorization `code`.
     *
     * @throws OAuthException The callback does not match, carries an `error`, or has no `code`.
     */
    public fun getAuthorizationCode(callbackUrl: String, expectedState: String, expectedRedirectUri: String): String {
        if (!callbackUrl.startsWith("$expectedRedirectUri?")) {
            throw OAuthException("Invalid authorization response", OAuthErrorKind.InvalidAuthorizationResponse)
        }

        val query = parseQuery(callbackUrl)
        fun first(name: String): String? = query.firstOrNull { it.first == name }?.second

        if (first("state") != expectedState) {
            throw OAuthException("Invalid authorization response", OAuthErrorKind.InvalidAuthorizationResponse)
        }

        first("error")?.let { error ->
            throw OAuthException(
                "Authorization request failed",
                OAuthErrorKind.AuthorizationRequestFailed,
                error,
                first("error_description"),
                first("error_uri"),
            )
        }

        return first("code") ?: throw OAuthException("Invalid authorization response", OAuthErrorKind.InvalidAuthorizationResponse)
    }

    /** Exchanges an authorization code for tokens. */
    public suspend fun getAccessTokenByCode(code: String, redirectUri: String, pkce: Pkce): Token = postToken(
        listOf(
            "grant_type" to "authorization_code",
            "code" to code,
            "redirect_uri" to redirectUri,
            "client_id" to clientId,
            "code_verifier" to pkce.verifier,
        ),
    )

    /** Exchanges a refresh token for new tokens. */
    public suspend fun getAccessTokenByRefreshToken(refreshToken: String): Token = postToken(
        listOf(
            "grant_type" to "refresh_token",
            "refresh_token" to refreshToken,
            "client_id" to clientId,
            "client_secret" to clientSecret,
        ),
    )

    /**
     * Exchanges an Android Restore Credentials result for tokens, without user interaction.
     *
     * @param credential The authentication response JSON string returned by Credential Manager, passed as is.
     * @throws OAuthException `error` is `invalid_grant` when the restore key has expired or been revoked.
     */
    public suspend fun getAccessTokenByRestoreCredential(credential: String): Token = postToken(
        listOf(
            "grant_type" to "urn:natsuneko:params:oauth:grant-type:restore_credential",
            "credential" to credential,
            "client_id" to clientId,
            "client_secret" to clientSecret,
        ),
    )

    /** Closes the HTTP client created for token requests; a client passed to the constructor stays open. */
    override fun close() {
        if (http.isInitialized()) http.value.close()
    }

    private suspend fun postToken(form: List<Pair<String, String>>): Token {
        // The form is pure ASCII, so the content type carries no charset.
        val response = http.value.post("$baseUrl/token") {
            contentType(ContentType.Application.FormUrlEncoded)
            setBody(formEncode(form).toByteArray(Charsets.US_ASCII))
        }
        if (!response.status.isSuccess()) {
            throw tokenErrorResponse(response)
        }
        return decodeToken(response.bodyAsBytes())
    }

    /** Carries the OAuth error fields of a body such as `{"error":"invalid_grant","error_description":"..."}`, when there are any. */
    private suspend fun tokenErrorResponse(response: HttpResponse): OAuthException {
        val root = try {
            Json.parseToJsonElement(response.bodyAsBytes().decodeToString())
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            return invalidTokenResponse()
        }
        val error = (root as? JsonObject)?.optionalString("error") ?: return invalidTokenResponse()

        return OAuthException(
            "Invalid token response",
            OAuthErrorKind.InvalidTokenResponse,
            error = error,
            errorDescription = root.optionalString("error_description"),
            errorUri = root.optionalString("error_uri"),
        )
    }

    private companion object {
        val invalidTokenResponse: () -> OAuthException = { OAuthException("Invalid token response", OAuthErrorKind.InvalidTokenResponse) }

        /**
         * Only `access_token`, `refresh_token` and `token_type` are required. The other fields are optional, and a
         * value of the wrong type (or an `expires_at` that is not an ISO 8601 date-time) counts as absent.
         */
        fun decodeToken(body: ByteArray): Token {
            val root: JsonElement = try {
                Json.parseToJsonElement(body.decodeToString())
            } catch (_: SerializationException) {
                throw invalidTokenResponse()
            } catch (_: IllegalArgumentException) {
                throw invalidTokenResponse()
            }
            if (root !is JsonObject) throw invalidTokenResponse()

            return Token(
                accessToken = root.requiredString("access_token"),
                refreshToken = root.requiredString("refresh_token"),
                tokenType = root.requiredString("token_type"),
                scope = root.optionalString("scope"),
                expiresAt = root.optionalString("expires_at")?.takeIf { isIsoDateTime(it) },
                expiresIn = root.optionalInt("expires_in"),
            )
        }

        fun JsonObject.optionalString(name: String): String? = (this[name] as? JsonPrimitive)?.takeIf { it.isString }?.content

        fun JsonObject.requiredString(name: String): String = optionalString(name) ?: throw invalidTokenResponse()

        fun JsonObject.optionalInt(name: String): Int? {
            val primitive = (this[name] as? JsonPrimitive)?.takeIf { !it.isString } ?: return null
            primitive.content.toIntOrNull()?.let { return it }
            val number = primitive.content.toDoubleOrNull() ?: return null
            return if (number == floor(number) && abs(number) <= Int.MAX_VALUE) number.toInt() else null
        }

        fun isIsoDateTime(text: String): Boolean = try {
            DateTimeFormatter.ISO_DATE_TIME.parse(text)
            true
        } catch (_: DateTimeParseException) {
            false
        }

        // application/x-www-form-urlencoded, matching URLSearchParams: only A-Z a-z 0-9 * - . _ stay as they are, space is "+".
        fun formEncode(pairs: List<Pair<String, String>>): String =
            pairs.joinToString("&") { (name, value) -> "${formEncodeComponent(name)}=${formEncodeComponent(value)}" }

        fun formEncodeComponent(value: String): String {
            val builder = StringBuilder()
            for (byte in value.toByteArray(Charsets.UTF_8)) {
                val c = (byte.toInt() and 0xFF).toChar()
                when {
                    c in 'A'..'Z' || c in 'a'..'z' || c in '0'..'9' || c == '*' || c == '-' || c == '.' || c == '_' -> builder.append(c)
                    c == ' ' -> builder.append('+')
                    else -> builder.append('%').append("%02X".format(byte.toInt() and 0xFF))
                }
            }
            return builder.toString()
        }

        /** The decoded `name=value` pairs of the query, in order (the fragment is ignored). */
        fun parseQuery(url: String): List<Pair<String, String>> {
            val withoutFragment = url.substringBefore('#')
            if ('?' !in withoutFragment) return emptyList()
            return withoutFragment.substringAfter('?')
                .split('&')
                .filter { it.isNotEmpty() }
                .map { pair -> decode(pair.substringBefore('=')) to decode(if ('=' in pair) pair.substringAfter('=') else "") }
        }

        /** Form-decodes `+` and `%XX` (UTF-8); invalid `%` sequences are left as they are instead of throwing. */
        fun decode(text: String): String {
            val bytes = java.io.ByteArrayOutputStream()
            var i = 0
            while (i < text.length) {
                val c = text[i]
                val high = if (c == '%' && i + 2 < text.length) Character.digit(text[i + 1], 16) else -1
                val low = if (high >= 0) Character.digit(text[i + 2], 16) else -1
                when {
                    high >= 0 && low >= 0 -> {
                        bytes.write(high * 16 + low)
                        i += 3
                    }
                    c == '+' -> {
                        bytes.write(' '.code)
                        i++
                    }
                    else -> {
                        val end = if (c.isHighSurrogate() && i + 1 < text.length) i + 2 else i + 1
                        bytes.write(text.substring(i, end).toByteArray(Charsets.UTF_8))
                        i = end
                    }
                }
            }
            return bytes.toByteArray().toString(Charsets.UTF_8)
        }
    }
}
