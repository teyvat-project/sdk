# CatalystSwift

Official Catalyst Swift SDK for Apple platforms.

The API client under `Generated/` is produced by archon from the Catalyst OpenAPI spec. `Sources/CatalystSwift` is a thin layer on top of it that adds OAuth (authorization code + PKCE), automatic token refresh and the `User-Agent` header.

Requires macOS 12 / iOS 15 / tvOS 15 / watchOS 8 / visionOS 1 or later (PKCE uses CryptoKit).

## Installation

### Swift Package Manager

```swift
.package(url: "https://github.com/mika-f/CatalystSwift.git", from: "2026.10.25")
```

```swift
.target(name: "YourApp", dependencies: [
  .product(name: "CatalystSwift", package: "CatalystSwift"),
])
```

## Usage

### Calling the API

```swift
import CatalystSwift

let catalyst = Catalyst(
  clientId: "your-client-id",
  clientSecret: "your-client-secret",
  accessToken: "access-token",
  refreshToken: "refresh-token",
  onTokenRefreshed: { token in
    // Persist token.accessToken / token.refreshToken.
  }
)

let gallery = try await catalyst.api.catalyst.getCatalystV1Gallery()
```

`catalyst.api` is the generated `ApiClient`; every service (`catalyst`, `media`, `egeria`, ...) is available on it, and all generated types are re-exported from `CatalystSwift`.

When a request fails with `401` and a refresh token is set, the access token is refreshed once (concurrent requests share a single refresh) and the request is replayed with the new token. If the refresh fails, the original `401` is returned as an `ApiError`. Without an access token, operations that require one throw `AuthError` before anything is sent.

### Credentials

```swift
await catalyst.setCredential(accessToken: "at", refreshToken: "rt")
let accessToken = await catalyst.accessToken
let token = try await catalyst.refresh()
await catalyst.clearCredential()
```

### Sign in with OAuth (authorization code + PKCE)

```swift
let oauth = catalyst.oauth
let pkce = PKCE.create()
let state = UUID().uuidString

// 1. Send the user to the authorization page.
let url = oauth.getAuthorizeURL(redirectUri: "myapp://callback", pkce: pkce, state: state)

// 2. Handle the redirect.
let code = try oauth.getAuthorizationCode(
  callbackUrl: callbackUrl,
  expectedState: state,
  expectedRedirectUri: "myapp://callback"
)

// 3. Exchange the code for tokens.
let token = try await oauth.getAccessTokenByCode(code: code, redirectUri: "myapp://callback", pkce: pkce)
await catalyst.setCredential(accessToken: token.accessToken, refreshToken: token.refreshToken)
```

Failures are reported as `OAuthError` (`authorizationRequestFailed`, `invalidAuthorizationResponse`, `invalidTokenResponse`).

## License

MIT
