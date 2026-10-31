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
import { Catalyst } from "@natsuneko-laboratory/catalyst-sdk";

const catalyst = new Catalyst({
  clientId: "your-client-id",
  clientSecret: "your-client-secret",
  accessToken: "access-token",
  refreshToken: "refresh-token",
  onTokenRefreshed: async (token) => {
    // persist token.accessToken / token.refreshToken
  },
});

// GET /catalyst/v1.1/timeline/home
const { data, error } = await catalyst.catalyst.v11.timeline.home.get();

// Path parameters, query parameters and the body go in `path`, `query` and `body`.
const status = await catalyst.catalyst.v11.status.id.get({ path: { id: "status-id" } });
await catalyst.catalyst.v1.relationships.bulk.create({ body: { userIds: ["user-id"] } });

// With `throwOnError: true`, a non-2xx response throws an `ApiError` instead of being returned.
const { data: me } = await catalyst.egeria.v1.me.get({ throwOnError: true });
```

Every operation is reachable from `Catalyst` by its path, as in the old CatalystTS SDK. The first path segment is the service (`catalyst`, `egeria`, `epiclese`, `featureFlags`, `giftia`, `media`, `steambird`); every following segment is camelCased (`v1.1` → `v11`, `on-this-day` → `onThisDay`, `{id}` → `id`); the method is named after the HTTP method (`GET` → `get`, `POST` → `create`, `PUT` → `update`, `PATCH` → `patch`, `DELETE` → `delete`). Each call returns `{ data, error, response }`.

The nested methods call the generated operation functions, which are also exported. Pass `catalyst.client` to call one directly:

```ts
import { getCatalystV11TimelineHome } from "@natsuneko-laboratory/catalyst-sdk";

const { data } = await getCatalystV11TimelineHome({ client: catalyst.client });
```

`createFacade(client)` builds the same nested object for a client you created yourself with `createApiClient`.

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

On Android, `catalyst.oauth.getAccessTokenByRestoreCredential(credential)` exchanges a Restore Credentials result (the JSON string as-is) for a token without user interaction. When a token request fails, `OAuthError.info.error` carries the server's OAuth error code (e.g. `invalid_grant`).

Failures are reported as `OAuthError` with `kind` of `authorizationRequestFailed`, `invalidAuthorizationResponse` or `invalidTokenResponse`.
