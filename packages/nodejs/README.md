# CatalystTS

TypeScript/JavaScript SDK for the Natsuneko Laboratory platform. ESM only.

The API client is generated from the OpenAPI spec by [archon](https://github.com/natsuneko-laboratory/archon). `Catalyst` is a thin layer on top of it that wires up authentication, a `User-Agent` header and automatic token refresh.

## Install

```sh
# Stable releases
npm install @natsuneko-laboratory/catalyst-sdk

# Betas (published to the `beta` dist-tag)
npm install @natsuneko-laboratory/catalyst-sdk@beta
```

Until the first stable `2026.x` release, the `latest` dist-tag still points to the old `1.0.0-alpha.17`, so use `@beta` to get this SDK.

The package is ESM only; CommonJS `require()` is not supported.

## Usage

```ts
import { Catalyst, getCatalystV11Random } from "@natsuneko-laboratory/catalyst-sdk";

const catalyst = new Catalyst({
  clientId: "your-client-id",
  clientSecret: "your-client-secret",
  accessToken: "access-token",
  refreshToken: "refresh-token",
  onTokenRefreshed: async (token) => {
    // persist token.accessToken / token.refreshToken
  },
});

// Pass the configured client to any generated operation.
const { data, error } = await getCatalystV11Random({ client: catalyst.client });
```

When a request returns `401` and a refresh token is set, the SDK refreshes the access token once (concurrent requests share a single refresh) and retries. If the refresh fails, the original `401` is returned as an `ApiError`. Calling an operation that needs a bearer token without an access token fails with `AuthError` before any request is sent.

Other members: `catalyst.accessToken`, `catalyst.refreshToken`, `catalyst.setCredential(accessToken, refreshToken?)`, `catalyst.clearCredential()`, `catalyst.refresh()`.

Options `baseUrl`, `middleware` (run before the built-in User-Agent and 401 middleware) and `fetch` (replaces the global `fetch`) are also available.

## OAuth (authorization code + PKCE)

```ts
import { Catalyst, PKCE } from "@natsuneko-laboratory/catalyst-sdk";

const catalyst = new Catalyst({ clientId: "...", clientSecret: "..." });
const redirectUri = "app://callback";
const state = crypto.randomUUID();
const pkce = await PKCE.create();

// 1. Send the user to the authorization page.
const authorizeUrl = catalyst.oauth.getAuthorizeURL(redirectUri, pkce, state);

// 2. After the redirect, validate the callback and exchange the code.
const code = catalyst.oauth.getAuthorizationCode(new URL(callbackUrl), state, redirectUri);
const token = await catalyst.oauth.getAccessTokenByCode(code, redirectUri, pkce);
catalyst.setCredential(token.accessToken, token.refreshToken);
```

Failures are reported as `OAuthError` with `kind` of `authorizationRequestFailed`, `invalidAuthorizationResponse` or `invalidTokenResponse`.
