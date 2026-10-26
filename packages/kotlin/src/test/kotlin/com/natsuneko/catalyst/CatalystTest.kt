package com.natsuneko.catalyst

import com.natsuneko.catalyst.api.core.ApiAuthException
import com.natsuneko.catalyst.api.core.ApiException
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.utils.io.core.toByteArray
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.test.runTest
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class CatalystTest {
    private val tokenBody =
        """{"access_token":"at2","refresh_token":"rt2","token_type":"Bearer","scope":"read write","expires_at":"2026-10-26T00:00:00Z","expires_in":3600}"""

    private class Recorded(val method: HttpMethod, val url: String, val path: String, val authorization: String?, val userAgent: String?, val body: String) {
        val isToken: Boolean get() = path == "/token"
    }

    private class Mock(handler: suspend MockRequestHandleScope.(Recorded) -> HttpResponseData) {
        val requests = CopyOnWriteArrayList<Recorded>()
        val engine = MockEngine { request ->
            val recorded = request.record()
            requests.add(recorded)
            handler(recorded)
        }
        val client = HttpClient(engine)
        val tokenRequests: List<Recorded> get() = requests.filter { it.isToken }
        val apiRequests: List<Recorded> get() = requests.filter { !it.isToken }
    }

    private companion object {
        fun HttpRequestData.record() = Recorded(
            method,
            url.toString(),
            url.encodedPath,
            headers[HttpHeaders.Authorization],
            headers[HttpHeaders.UserAgent],
            body.toByteArray().decodeToString(),
        )

        fun io.ktor.http.content.OutgoingContent.toByteArray(): ByteArray = when (this) {
            is io.ktor.http.content.OutgoingContent.ByteArrayContent -> bytes()
            else -> ByteArray(0)
        }

        val jsonHeaders = headersOf(HttpHeaders.ContentType, "application/json")

        fun MockRequestHandleScope.json(status: HttpStatusCode, body: String): HttpResponseData = respond(body, status, jsonHeaders)

        fun MockRequestHandleScope.ok(): HttpResponseData = json(HttpStatusCode.OK, "[]")
    }

    @Test
    fun sendsBearerToken() = runTest {
        val mock = Mock { ok() }
        val catalyst = Catalyst(CatalystOptions().apply {
            clientId = "cid"
            clientSecret = "cs"
            accessToken = "at1"
            httpClient = mock.client
        })

        catalyst.api.catalyst.getCatalystV1Gallery()

        val request = mock.requests.single()
        assertEquals("Bearer at1", request.authorization)
        assertEquals("CatalystKotlin", request.userAgent)
    }

    @Test
    fun refreshesOn401AndRetries() = runTest {
        val refreshed = CopyOnWriteArrayList<Token>()
        val mock = Mock { request ->
            when {
                request.isToken -> json(HttpStatusCode.OK, tokenBody)
                request.authorization == "Bearer at2" -> ok()
                else -> json(HttpStatusCode.Unauthorized, "{}")
            }
        }
        val catalyst = Catalyst(CatalystOptions().apply {
            clientId = "cid"
            clientSecret = "cs"
            accessToken = "at1"
            refreshToken = "rt1"
            httpClient = mock.client
            onTokenRefreshed = { refreshed.add(it) }
        })

        catalyst.api.catalyst.getCatalystV1Gallery()

        assertEquals(3, mock.requests.size)
        val tokenRequest = mock.requests[1]
        assertEquals("https://api.natsuneko.com/token", tokenRequest.url)
        assertEquals(HttpMethod.Post, tokenRequest.method)
        assertTrue(
            "grant_type=refresh_token&refresh_token=rt1&client_id=cid&client_secret=cs" in tokenRequest.body,
            "unexpected token request body: ${tokenRequest.body}",
        )
        assertEquals("Bearer at2", mock.requests[2].authorization)
        assertEquals("at2", refreshed.single().accessToken)
        assertEquals("at2", catalyst.accessToken)
        assertEquals("rt2", catalyst.refreshToken)
    }

    @Test
    fun concurrent401sRefreshOnce() = runTest {
        val unauthorized = AtomicInteger()
        val bothUnauthorized = CompletableDeferred<Unit>()
        val mock = Mock { request ->
            when {
                request.isToken -> {
                    // Hold the refresh until both calls have been rejected, so neither can start a second one.
                    bothUnauthorized.await()
                    json(HttpStatusCode.OK, tokenBody)
                }
                request.authorization == "Bearer at2" -> ok()
                else -> {
                    if (unauthorized.incrementAndGet() == 2) bothUnauthorized.complete(Unit)
                    json(HttpStatusCode.Unauthorized, "{}")
                }
            }
        }
        val catalyst = Catalyst(CatalystOptions().apply {
            clientId = "cid"
            clientSecret = "cs"
            accessToken = "at1"
            refreshToken = "rt1"
            httpClient = mock.client
        })

        listOf(
            async { catalyst.api.catalyst.getCatalystV1Gallery() },
            async { catalyst.api.catalyst.getCatalystV1Gallery() },
        ).awaitAll()

        assertEquals(1, mock.tokenRequests.size)
        assertEquals(4, mock.apiRequests.size)
        assertEquals(2, mock.apiRequests.count { it.authorization == "Bearer at2" })
    }

    @Test
    fun missingTokenThrowsAuthError() = runTest {
        val mock = Mock { ok() }
        val catalyst = Catalyst(CatalystOptions().apply {
            clientId = "cid"
            clientSecret = "cs"
            httpClient = mock.client
        })

        assertFailsWith<ApiAuthException> { catalyst.api.catalyst.getCatalystV1Gallery() }

        assertTrue(mock.requests.isEmpty())
    }

    @Test
    fun failedRefreshReturnsOriginal401() = runTest {
        val mock = Mock { request ->
            if (request.isToken) json(HttpStatusCode.BadRequest, """{"error":"invalid_grant"}""")
            else json(HttpStatusCode.Unauthorized, "{}")
        }
        val catalyst = Catalyst(CatalystOptions().apply {
            clientId = "cid"
            clientSecret = "cs"
            accessToken = "at1"
            refreshToken = "rt1"
            httpClient = mock.client
        })

        val error = assertFailsWith<ApiException> { catalyst.api.catalyst.getCatalystV1Gallery() }

        assertEquals(401, error.statusCode)
        assertEquals("at1", catalyst.accessToken)
        assertEquals(1, mock.tokenRequests.size)
        assertEquals(1, mock.apiRequests.size)
    }
}
