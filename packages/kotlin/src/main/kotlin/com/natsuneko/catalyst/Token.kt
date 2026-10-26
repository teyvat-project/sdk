package com.natsuneko.catalyst

/**
 * The result of a token exchange.
 *
 * @property accessToken The access token.
 * @property refreshToken The refresh token.
 * @property tokenType The token type (e.g. `Bearer`).
 * @property scope Present on responses from the real token-exchange endpoint (e.g. `read write`).
 * @property expiresAt ISO 8601 timestamp for when the access token expires.
 * @property expiresIn Seconds until the access token expires.
 */
public data class Token(
    val accessToken: String,
    val refreshToken: String,
    val tokenType: String,
    val scope: String? = null,
    val expiresAt: String? = null,
    val expiresIn: Int? = null,
)
