import { describe, expect, it } from "vitest";
import { OAuth, OAuthError, PKCE } from "../src/index.js";

describe("PKCE / OAuth", () => {
  it("pkceMatchesRfc7636Vector", async () => {
    const pkce = await PKCE.fromVerifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");

    expect(pkce.challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(pkce.method).toBe("S256");
  });

  it("authorizeUrlHasParams", async () => {
    const oauth = new OAuth("cid", "cs");
    const pkce = await PKCE.create();

    const url = oauth.getAuthorizeURL("app://cb", pkce, "st");

    expect(url.origin + url.pathname).toBe("https://accounts.natsuneko.com/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe("app://cb");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("code_challenge")).toBe(pkce.challenge);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("authorizationCodeRejectsStateMismatch", () => {
    const oauth = new OAuth("cid", "cs");

    let thrown: unknown;
    try {
      oauth.getAuthorizationCode(new URL("app://cb?code=c&state=other"), "st", "app://cb");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(OAuthError);
    expect((thrown as OAuthError).kind).toBe("invalidAuthorizationResponse");
    expect(oauth.getAuthorizationCode(new URL("app://cb?code=c&state=st"), "st", "app://cb")).toBe("c");
  });

  it("tokenResponseWithOnlyRequiredFields", async () => {
    const respond = (body: unknown) => async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    const oauth = new OAuth("cid", "cs", {
      fetch: respond({ access_token: "at", refresh_token: "rt", token_type: "Bearer", expires_at: "not-a-date" }),
    });

    const token = await oauth.getAccessTokenByRefreshToken("rt0");

    expect(token.accessToken).toBe("at");
    expect(token.refreshToken).toBe("rt");
    expect(token.tokenType).toBe("Bearer");
    expect(token.scope).toBeUndefined();
    expect(token.expiresAt).toBeUndefined();
    expect(token.expiresIn).toBeUndefined();

    const incomplete = new OAuth("cid", "cs", { fetch: respond({ access_token: "at", token_type: "Bearer" }) });
    let thrown: unknown;
    try {
      await incomplete.getAccessTokenByRefreshToken("rt0");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OAuthError);
    expect((thrown as OAuthError).kind).toBe("invalidTokenResponse");
  });

  it("restoreCredentialGrantPostsCredential", async () => {
    let sent: URLSearchParams | undefined;
    const oauth = new OAuth("cid", "cs", {
      fetch: async (_input, init) => {
        sent = new URLSearchParams(String(init?.body));
        return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", token_type: "Bearer" }), { status: 200 });
      },
    });

    const token = await oauth.getAccessTokenByRestoreCredential('{"id":"x"}');

    expect(sent?.get("grant_type")).toBe("urn:natsuneko:params:oauth:grant-type:restore_credential");
    expect(sent?.get("client_id")).toBe("cid");
    expect(sent?.get("client_secret")).toBe("cs");
    expect(sent?.get("credential")).toBe('{"id":"x"}');
    expect(token.accessToken).toBe("at");
  });

  const failWith = async (status: number, body: string, call: (oauth: OAuth) => Promise<unknown>): Promise<OAuthError> => {
    const oauth = new OAuth("cid", "cs", { fetch: async () => new Response(body, { status }) });
    let thrown: unknown;
    try {
      await call(oauth);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OAuthError);
    return thrown as OAuthError;
  };

  it("tokenErrorCarriesOAuthErrorCode", async () => {
    const body = JSON.stringify({ code: 400, error: "invalid_grant", message: "m", error_description: "expired", error_uri: "https://example.com/e" });

    const thrown = await failWith(400, body, (oauth) => oauth.getAccessTokenByRestoreCredential("{}"));

    expect(thrown.kind).toBe("invalidTokenResponse");
    expect(thrown.info).toEqual({ error: "invalid_grant", description: "expired", uri: "https://example.com/e" });
  });

  it("tokenErrorWithoutErrorFieldHasNoInfo", async () => {
    const thrown = await failWith(400, JSON.stringify({ message: "x" }), (oauth) => oauth.getAccessTokenByRestoreCredential("{}"));

    expect(thrown.kind).toBe("invalidTokenResponse");
    expect(thrown.info).toBeUndefined();
  });

  it("tokenErrorWithNonJsonBodyHasNoInfo", async () => {
    const thrown = await failWith(400, "oops", (oauth) => oauth.getAccessTokenByRestoreCredential("{}"));

    expect(thrown.kind).toBe("invalidTokenResponse");
    expect(thrown.info).toBeUndefined();
  });

  it("refreshTokenErrorAlsoCarriesInfo", async () => {
    const thrown = await failWith(400, JSON.stringify({ error: "invalid_grant" }), (oauth) => oauth.getAccessTokenByRefreshToken("rt0"));

    expect(thrown.info?.error).toBe("invalid_grant");
    expect(thrown.info?.description).toBeUndefined();
  });
});
