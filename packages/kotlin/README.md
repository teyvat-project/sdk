# CatalystKotlin

Official Catalyst Kotlin SDK for JVM platforms.

The API client under `src/generated/kotlin/` is produced by archon from the Catalyst OpenAPI spec (package `com.natsuneko.catalyst.api`). The rest of the package is a thin layer on top of it that adds OAuth (authorization code + PKCE), automatic token refresh and the `User-Agent` header.

Requires Java 11 or later. HTTP is sent with Ktor, so add a Ktor client engine (for example `io.ktor:ktor-client-cio`) to your application, or pass your own client through `CatalystOptions.httpClient`.

## Installation

CatalystKotlin is not published to Maven Central or any other repository. Each version is attached to the GitHub Release `kotlin/v<version>` of [mika-f/CatalystSDK](https://github.com/mika-f/CatalystSDK/releases) as `catalyst-kotlin-<version>.jar`, `catalyst-kotlin-<version>-sources.jar` and `catalyst-kotlin-<version>.pom`.

```sh
gh release download kotlin/v2026.10.25 --repo mika-f/CatalystSDK --dir libs

# Check that the jar was built by this repository's release workflow
gh attestation verify libs/catalyst-kotlin-2026.10.25.jar --repo mika-f/CatalystSDK
```

A local jar brings no transitive dependencies, so add the ones from the `.pom` and a Ktor client engine yourself:

```kotlin
dependencies {
    implementation(files("libs/catalyst-kotlin-2026.10.25.jar"))
    implementation("io.ktor:ktor-client-core:3.6.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.12.0")
    implementation("io.ktor:ktor-client-cio:3.6.0") // any Ktor client engine
}
```

## Usage

### Calling the API

```kotlin
import com.natsuneko.catalyst.Catalyst
import com.natsuneko.catalyst.CatalystOptions

val catalyst = Catalyst(CatalystOptions().apply {
    clientId = "your-client-id"
    clientSecret = "your-client-secret"
    accessToken = "access-token"
    refreshToken = "refresh-token"
    onTokenRefreshed = { token ->
        // Persist token.accessToken / token.refreshToken.
    }
})

val gallery = catalyst.api.catalyst.getCatalystV1Gallery()
```

`catalyst.api` is the generated `ApiClient`; every service (`catalyst`, `media`, `egeria`, ...) is available on it. Pass your own Ktor `HttpClient` through `CatalystOptions.httpClient` (it is not closed by the SDK) and extra middleware through `CatalystOptions.middleware`; user middleware runs before the built-in `User-Agent` and 401-refresh middleware. Call `catalyst.close()` when you are done.

When a request fails with `401` and a refresh token is set, the access token is refreshed once (concurrent requests share a single refresh) and the request is replayed with the new token. If the refresh fails, the original `401` is thrown as an `ApiException`. Without an access token, operations that require one throw `ApiAuthException` before anything is sent.

### Credentials

```kotlin
catalyst.setCredential("at", "rt")   // a null refresh token clears the stored one
val accessToken = catalyst.accessToken
val token = catalyst.refresh()        // suspend
catalyst.clearCredential()
```

### Sign in with OAuth (authorization code + PKCE)

```kotlin
import com.natsuneko.catalyst.auth.Pkce
import java.util.UUID

val oauth = catalyst.oauth
val pkce = Pkce.create()
val state = UUID.randomUUID().toString()

// 1. Send the user to the authorization page.
val url = oauth.getAuthorizeUrl("myapp://callback", pkce, state)

// 2. Handle the redirect.
val code = oauth.getAuthorizationCode(callbackUrl, state, "myapp://callback")

// 3. Exchange the code for tokens.
val token = oauth.getAccessTokenByCode(code, "myapp://callback", pkce)
catalyst.setCredential(token.accessToken, token.refreshToken)
```

Failures are reported as `OAuthException`; `kind` is `AuthorizationRequestFailed`, `InvalidAuthorizationResponse` or `InvalidTokenResponse`.

## License

MIT
