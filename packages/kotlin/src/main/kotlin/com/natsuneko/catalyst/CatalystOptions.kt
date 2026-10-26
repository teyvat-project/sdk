package com.natsuneko.catalyst

import com.natsuneko.catalyst.api.core.Middleware
import io.ktor.client.HttpClient

/** Settings for [Catalyst]. [clientId] and [clientSecret] are required. */
public class CatalystOptions {
    public lateinit var clientId: String

    public lateinit var clientSecret: String

    public var accessToken: String? = null

    public var refreshToken: String? = null

    /** Defaults to `https://api.natsuneko.com`. */
    public var baseUrl: String = PUBLIC_API_ENDPOINT

    /** Runs before the built-in User-Agent and 401-refresh middleware. */
    public val middleware: MutableList<Middleware> = mutableListOf()

    /**
     * Replacement for the default Ktor client, used for both API and token requests. It is never closed by the SDK,
     * and redirects are not followed for the requests the SDK sends.
     */
    public var httpClient: HttpClient? = null

    /** Called after every successful token refresh. An exception it throws propagates out of [Catalyst.refresh]. */
    public var onTokenRefreshed: (suspend (Token) -> Unit)? = null
}
