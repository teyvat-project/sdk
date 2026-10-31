import { PUBLIC_API_ENDPOINT, PUBLIC_AUTHORIZE_ENDPOINT } from "../types/constants.js";
import type { AccessTokenResponse } from "../generated/index.js";
import type { Token } from "../types/token.js";
import type { PKCE } from "./pkce.js";

export class OAuthError extends Error {
  constructor(
    message: string,
    public readonly kind: "authorizationRequestFailed" | "invalidAuthorizationResponse" | "invalidTokenResponse",
    public readonly info?: { error: string; description?: string; uri?: string },
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

export interface OAuthOptions {
  /** Base URL of the API; the token endpoint is `<baseUrl>/token`. */
  baseUrl?: string;
  /** Authorization endpoint used by `getAuthorizeURL`. */
  authorizeEndpoint?: string;
  /** Replacement for the global `fetch`, used for token requests. */
  fetch?: typeof fetch;
}

export class OAuth {
  private readonly baseUrl: string;
  private readonly authorizeEndpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    options: OAuthOptions = {},
  ) {
    this.baseUrl = (options.baseUrl ?? PUBLIC_API_ENDPOINT).replace(/\/+$/, "");
    this.authorizeEndpoint = options.authorizeEndpoint ?? PUBLIC_AUTHORIZE_ENDPOINT;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async getAccessTokenByCode(code: string, redirectUri: string, pkce: PKCE): Promise<Token> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: this.clientId,
      code_verifier: pkce.verifier,
    });

    return this.postToken(body);
  }

  async getAccessTokenByRefreshToken(refreshToken: string): Promise<Token> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    return this.postToken(body);
  }

  /** `credential` is the authentication result JSON string returned by Android's Credential Manager, passed as-is. */
  async getAccessTokenByRestoreCredential(credential: string): Promise<Token> {
    const body = new URLSearchParams({
      grant_type: "urn:natsuneko:params:oauth:grant-type:restore_credential",
      credential,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    return this.postToken(body);
  }

  getAuthorizeURL(redirectUri: string, pkce: PKCE, state: string): URL {
    const url = new URL(this.authorizeEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", pkce.challenge);
    url.searchParams.set("code_challenge_method", pkce.method);
    return url;
  }

  getAuthorizationCode(callbackUrl: URL, expectedState: string, expectedRedirectUri: string): string {
    this.verifyAuthorizationResponse(callbackUrl, expectedState, expectedRedirectUri);

    const error = callbackUrl.searchParams.get("error");
    if (error != null) {
      throw new OAuthError("Authorization request failed", "authorizationRequestFailed", {
        error,
        description: callbackUrl.searchParams.get("error_description") ?? undefined,
        uri: callbackUrl.searchParams.get("error_uri") ?? undefined,
      });
    }

    const code = callbackUrl.searchParams.get("code");
    if (code == null) throw new OAuthError("Invalid authorization response", "invalidAuthorizationResponse");

    return code;
  }

  private verifyAuthorizationResponse(url: URL, expectedState: string, expectedRedirectUri: string): void {
    if (!url.href.startsWith(expectedRedirectUri + "?")) {
      throw new OAuthError("Invalid authorization response", "invalidAuthorizationResponse");
    }

    if (url.searchParams.get("state") !== expectedState) {
      throw new OAuthError("Invalid authorization response", "invalidAuthorizationResponse");
    }
  }

  /**
   * Only `access_token`, `refresh_token` and `token_type` are required. The other fields are optional, and a value of
   * the wrong type (or an `expires_at` that is not an ISO 8601 date-time) counts as absent.
   */
  private async postToken(body: URLSearchParams): Promise<Token> {
    const response = await this.fetchImpl(`${this.baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      throw new OAuthError("Invalid token response", "invalidTokenResponse", await readOAuthErrorInfo(response));
    }

    let json: Partial<AccessTokenResponse>;
    try {
      json = (await response.json()) as Partial<AccessTokenResponse>;
    } catch {
      throw new OAuthError("Invalid token response", "invalidTokenResponse");
    }

    if (json == null || typeof json.access_token !== "string" || typeof json.refresh_token !== "string" || typeof json.token_type !== "string") {
      throw new OAuthError("Invalid token response", "invalidTokenResponse");
    }

    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      tokenType: json.token_type,
      scope: typeof json.scope === "string" ? json.scope : undefined,
      expiresAt: typeof json.expires_at === "string" && isIsoDateTime(json.expires_at) ? json.expires_at : undefined,
      expiresIn: typeof json.expires_in === "number" && Number.isFinite(json.expires_in) ? json.expires_in : undefined,
    };
  }
}

/** Extracts the OAuth error code from an error body such as `{"error":"invalid_grant","error_description":"..."}`. */
async function readOAuthErrorInfo(response: Response): Promise<OAuthError["info"]> {
  try {
    const json = (await response.json()) as { error?: unknown; error_description?: unknown; error_uri?: unknown } | null;
    if (json == null || typeof json.error !== "string") return undefined;

    return {
      error: json.error,
      description: typeof json.error_description === "string" ? json.error_description : undefined,
      uri: typeof json.error_uri === "string" ? json.error_uri : undefined,
    };
  } catch {
    return undefined;
  }
}

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/i;

function isIsoDateTime(text: string): boolean {
  return ISO_DATE_TIME.test(text) && !Number.isNaN(Date.parse(text));
}
