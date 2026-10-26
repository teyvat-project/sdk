# CatalystSharp

Official Catalyst C#/.NET SDK.

The API client under `CatalystSharp/Generated/` is produced by archon from the Catalyst OpenAPI spec (namespace `CatalystSharp.Api`). The rest of the package is a thin layer on top of it that adds OAuth (authorization code + PKCE), automatic token refresh and the `User-Agent` header.

Requires .NET 10 or later.

## Installation

```bash
dotnet add package CatalystSharp
```

## Usage

### Calling the API

```csharp
using CatalystSharp;

var catalyst = new Catalyst(new CatalystOptions
{
    ClientId = "your-client-id",
    ClientSecret = "your-client-secret",
    AccessToken = "access-token",
    RefreshToken = "refresh-token",
    OnTokenRefreshed = token =>
    {
        // Persist token.AccessToken / token.RefreshToken.
        return ValueTask.CompletedTask;
    },
});

var gallery = await catalyst.Api.Catalyst.GetCatalystV1GalleryAsync();
```

`catalyst.Api` is the generated `ApiClient`; every service (`Catalyst`, `Media`, `Egeria`, ...) is available on it. Pass your own `HttpClient` through `CatalystOptions.HttpClient` (its handler should set `AllowAutoRedirect = false`) and extra middleware through `CatalystOptions.Middleware`; user middleware runs before the built-in `User-Agent` and 401-refresh middleware.

When a request fails with `401` and a refresh token is set, the access token is refreshed once (concurrent requests share a single refresh) and the request is replayed with the new token. If the refresh fails, the original `401` is thrown as an `ApiException`. Without an access token, operations that require one throw `ApiAuthException` before anything is sent.

### Credentials

```csharp
catalyst.SetCredential("at", "rt");   // a null refresh token clears the stored one
var accessToken = catalyst.AccessToken;
var token = await catalyst.RefreshAsync();
catalyst.ClearCredential();
```

### Sign in with OAuth (authorization code + PKCE)

```csharp
using CatalystSharp.Auth;

var oauth = catalyst.OAuth;
var pkce = Pkce.Create();
var state = Guid.NewGuid().ToString();

// 1. Send the user to the authorization page.
var url = oauth.GetAuthorizeUrl("myapp://callback", pkce, state);

// 2. Handle the redirect.
var code = oauth.GetAuthorizationCode(callbackUrl, state, "myapp://callback");

// 3. Exchange the code for tokens.
var token = await oauth.GetAccessTokenByCodeAsync(code, "myapp://callback", pkce);
catalyst.SetCredential(token.AccessToken, token.RefreshToken);
```

Failures are reported as `OAuthException`; `Kind` is `AuthorizationRequestFailed`, `InvalidAuthorizationResponse` or `InvalidTokenResponse`.

## License

MIT
