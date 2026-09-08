# CatalystTS

Official Catalyst SDK for TypeScript / JavaScript / Node.js, built for both browser and server environments.

## Installation

```bash
$ npm install @natsuneko-laboratory/catalyst-sdk --save
```

If you are using React Native, you may need to install `@natsuneko-laboratory/react-native-webcrypto-digest` or other polyfills for `crypto.subtle.digest` depending on your environment:

```bash
$ npm install @natsuneko-laboratory/react-native-webcrypto-digest --save
```

## Usage

### Authentication (OAuth 2.0 + PKCE)

```typescript
import { CatalystTS, PKCE } from "@natsuneko-laboratory/catalyst-sdk";

const API_KEY = {
  clientId: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  clientSecret: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  redirectUri: "https://example.com/callback",
};

const client = new CatalystTS({
  clientId: API_KEY.clientId,
  clientSecret: API_KEY.clientSecret,
});

// 1. redirect the user to the authorization URL
const pkce = await PKCE.create();
const state = crypto.randomUUID();
const url = client.oauth.getAuthorizeURL(API_KEY.redirectUri, pkce, state);

// 2. after the user is redirected back to `redirectUri`, extract the
//    authorization code (state and redirect URI are verified for you,
//    throws OAuthError on failure)
const callbackUrl = new URL(window.location.href);
const code = client.oauth.getAuthorizationCode(callbackUrl, state, API_KEY.redirectUri);

// 3. exchange the code for tokens and attach them to the client
const token = await client.oauth.getAccessTokenByCode(code, API_KEY.redirectUri, pkce);
client.setCredential(token.accessToken, token.refreshToken);
```

If you already have tokens (e.g. restored from storage), pass them directly:

```typescript
const client = new CatalystTS({
  clientId: API_KEY.clientId,
  clientSecret: API_KEY.clientSecret,
  accessToken: storedAccessToken,
  refreshToken: storedRefreshToken,
});
```

### Calling APIs

API clients are generated from the OpenAPI schema by [@hey-api/openapi-ts](https://heyapi.dev/) and grouped by service:

```typescript
// GET /egeria/v1/me
const { data: me } = await client.egeria.egeria.v1.me.get();
console.log({ me });

// GET /epiclese/v1/authors
const { data: authors } = await client.epiclese.epiclese.v1.authors.get();
```

Available services: `client.catalyst`, `client.egeria`, `client.epiclese`, `client.featureFlags`, `client.media`, `client.steambird`.

### Automatic token refresh

When a request fails with `401 Unauthorized` and a refresh token is set, the SDK automatically refreshes the access token and retries the request (up to 5 times). Concurrent requests share a single refresh operation.

You can also refresh manually and read back the current tokens for persistence:

```typescript
const token = await client.refresh();

console.log(client.accessToken);
console.log(client.refreshToken);
```

### Interceptors

Requests, responses, and errors can be intercepted. A `LoggingInterceptor` is provided out of the box, and you can implement the `Interceptor` interface yourself:

```typescript
import { CatalystTS, LoggingInterceptor } from "@natsuneko-laboratory/catalyst-sdk";
import type { Interceptor } from "@natsuneko-laboratory/catalyst-sdk";

const myInterceptor: Interceptor = {
  onRequest: (request) => {
    request.headers.set("X-Custom-Header", "value");
    return request;
  },
};

const client = new CatalystTS({
  clientId: API_KEY.clientId,
  clientSecret: API_KEY.clientSecret,
  interceptors: [new LoggingInterceptor(), myInterceptor],
});
```

### Error handling

OAuth operations throw `OAuthError`, which carries a `kind` (`authorizationRequestFailed` | `invalidAuthorizationResponse` | `invalidTokenResponse`) and optional error details from the server:

```typescript
import { OAuthError } from "@natsuneko-laboratory/catalyst-sdk";

try {
  const code = client.oauth.getAuthorizationCode(callbackUrl, state, API_KEY.redirectUri);
} catch (err) {
  if (err instanceof OAuthError) {
    console.error(err.kind, err.info);
  }
}
```

## License

MIT by [@6jz](https://twitter.com/6jz)
