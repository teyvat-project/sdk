// Licensed under the MIT License
//
// Copyright (c) 2025 Natsune Mochizuki

package com.natsuneko.catalyst.auth

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/** A PKCE (RFC 7636) verifier / challenge pair using the `S256` method. */
public class Pkce private constructor(
    /** The code verifier. */
    public val verifier: String,
    /** The code challenge derived from [verifier]. */
    public val challenge: String,
) {
    /** The challenge method (always `S256`). */
    public val method: String = "S256"

    public companion object {
        /** Creates a pair from 32 random bytes. */
        public fun create(): Pkce {
            val bytes = ByteArray(32)
            SecureRandom().nextBytes(bytes)
            return fromVerifier(base64UrlEncode(bytes))
        }

        /** Builds a pair from a known verifier (e.g. for tests against RFC 7636 vectors). */
        public fun fromVerifier(verifier: String): Pkce {
            val hash = MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.UTF_8))
            return Pkce(verifier, base64UrlEncode(hash))
        }

        private fun base64UrlEncode(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }
}
