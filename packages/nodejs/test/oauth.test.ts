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
});
