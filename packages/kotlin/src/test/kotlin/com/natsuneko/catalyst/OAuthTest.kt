package com.natsuneko.catalyst

import com.natsuneko.catalyst.auth.OAuthClient
import com.natsuneko.catalyst.auth.OAuthErrorKind
import com.natsuneko.catalyst.auth.OAuthException
import com.natsuneko.catalyst.auth.Pkce
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.Url
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

class OAuthTest {
    @Test
    fun pkceMatchesRfc7636Vector() {
        val pkce = Pkce.fromVerifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")

        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", pkce.challenge)
        assertEquals("S256", pkce.method)
    }

    @Test
    fun authorizeUrlHasParams() {
        val oauth = OAuthClient("cid", "cs")
        val pkce = Pkce.create()

        val url = Url(oauth.getAuthorizeUrl("app://cb", pkce, "st"))

        assertEquals("https://accounts.natsuneko.com/authorize", "${url.protocol.name}://${url.host}${url.encodedPath}")
        assertEquals("code", url.parameters["response_type"])
        assertEquals("cid", url.parameters["client_id"])
        assertEquals("app://cb", url.parameters["redirect_uri"])
        assertEquals("st", url.parameters["state"])
        assertEquals(pkce.challenge, url.parameters["code_challenge"])
        assertEquals("S256", url.parameters["code_challenge_method"])
    }

    @Test
    fun authorizationCodeRejectsStateMismatch() {
        val oauth = OAuthClient("cid", "cs")

        val error = assertFailsWith<OAuthException> { oauth.getAuthorizationCode("app://cb?code=c&state=other", "st", "app://cb") }

        assertEquals(OAuthErrorKind.InvalidAuthorizationResponse, error.kind)
        assertEquals("c", oauth.getAuthorizationCode("app://cb?code=c&state=st", "st", "app://cb"))
    }

    @Test
    fun authorizationCodeToleratesMalformedEscapes() {
        val oauth = OAuthClient("cid", "cs")

        assertEquals("%", oauth.getAuthorizationCode("app://cb?code=%&state=st", "st", "app://cb"))

        val error = assertFailsWith<OAuthException> { oauth.getAuthorizationCode("app://cb?code=c&state=%zz", "st", "app://cb") }
        assertEquals(OAuthErrorKind.InvalidAuthorizationResponse, error.kind)
    }

    @Test
    fun tokenResponseWithOnlyRequiredFields() = runTest {
        val json = headersOf(HttpHeaders.ContentType, "application/json")
        val complete = MockEngine {
            respond("""{"access_token":"at","refresh_token":"rt","token_type":"Bearer","expires_at":"not-a-date"}""", HttpStatusCode.OK, json)
        }
        val oauth = OAuthClient("cid", "cs", httpClient = HttpClient(complete))

        val token = oauth.getAccessTokenByRefreshToken("rt0")

        assertEquals("at", token.accessToken)
        assertEquals("rt", token.refreshToken)
        assertEquals("Bearer", token.tokenType)
        assertNull(token.scope)
        assertNull(token.expiresAt)
        assertNull(token.expiresIn)

        val incomplete = MockEngine { respond("""{"access_token":"at","token_type":"Bearer"}""", HttpStatusCode.OK, json) }
        val error = assertFailsWith<OAuthException> {
            OAuthClient("cid", "cs", httpClient = HttpClient(incomplete)).getAccessTokenByRefreshToken("rt0")
        }
        assertEquals(OAuthErrorKind.InvalidTokenResponse, error.kind)
    }
}
