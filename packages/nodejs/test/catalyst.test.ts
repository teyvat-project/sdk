import { describe, expect, it } from "vitest";
import { ApiError, AuthError, Catalyst, getCatalystV11Random, type Token } from "../src/index.js";

interface Recorded {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
}

type Responder = (req: Recorded, index: number) => Response | Promise<Response>;

function mockFetch(responder: Responder) {
  const requests: Recorded[] = [];
  const fetchImpl = async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const req: Recorded = {
      url: input.toString(),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    requests.push(req);
    return responder(req, requests.length - 1);
  };
  return { fetch: fetchImpl, requests };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const tokenBody = {
  access_token: "at2",
  refresh_token: "rt2",
  token_type: "Bearer",
  scope: "read write",
  expires_at: "2026-10-26T00:00:00Z",
  expires_in: 3600,
};

const isToken = (r: Recorded) => r.url.endsWith("/token");

describe("Catalyst", () => {
  it("sendsBearerToken", async () => {
    const mock = mockFetch(() => json(200, {}));
    const catalyst = new Catalyst({ clientId: "cid", clientSecret: "cs", accessToken: "at1", fetch: mock.fetch });

    const result = await getCatalystV11Random({ client: catalyst.client });

    expect(result.error).toBeUndefined();
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]!.headers.get("Authorization")).toBe("Bearer at1");
    expect(mock.requests[0]!.headers.get("User-Agent")).toBe("CatalystTS");
  });

  it("refreshesOn401AndRetries", async () => {
    const refreshed: Token[] = [];
    const mock = mockFetch((req) => {
      if (isToken(req)) return json(200, tokenBody);
      return req.headers.get("Authorization") === "Bearer at2" ? json(200, {}) : json(401, {});
    });
    const catalyst = new Catalyst({
      clientId: "cid",
      clientSecret: "cs",
      accessToken: "at1",
      refreshToken: "rt1",
      fetch: mock.fetch,
      onTokenRefreshed: (token) => {
        refreshed.push(token);
      },
    });

    const result = await getCatalystV11Random({ client: catalyst.client });

    expect(result.error).toBeUndefined();
    expect(mock.requests).toHaveLength(3);
    const tokenRequest = mock.requests[1]!;
    expect(tokenRequest.url).toBe("https://api.natsuneko.com/token");
    expect(tokenRequest.method).toBe("POST");
    expect(tokenRequest.headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");
    expect(tokenRequest.body).toContain("grant_type=refresh_token&refresh_token=rt1&client_id=cid&client_secret=cs");
    expect(mock.requests[2]!.headers.get("Authorization")).toBe("Bearer at2");
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]!.accessToken).toBe("at2");
    expect(catalyst.accessToken).toBe("at2");
    expect(catalyst.refreshToken).toBe("rt2");
  });

  it("concurrent401sRefreshOnce", async () => {
    const mock = mockFetch(async (req) => {
      if (isToken(req)) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return json(200, tokenBody);
      }
      return req.headers.get("Authorization") === "Bearer at2" ? json(200, {}) : json(401, {});
    });
    const catalyst = new Catalyst({
      clientId: "cid",
      clientSecret: "cs",
      accessToken: "at1",
      refreshToken: "rt1",
      fetch: mock.fetch,
    });

    const [a, b] = await Promise.all([
      getCatalystV11Random({ client: catalyst.client }),
      getCatalystV11Random({ client: catalyst.client }),
    ]);

    expect(a.error).toBeUndefined();
    expect(b.error).toBeUndefined();
    expect(mock.requests.filter(isToken)).toHaveLength(1);
    const api = mock.requests.filter((r) => !isToken(r));
    expect(api).toHaveLength(4);
    expect(api.filter((r) => r.headers.get("Authorization") === "Bearer at2")).toHaveLength(2);
  });

  it("missingTokenThrowsAuthError", async () => {
    const mock = mockFetch(() => json(200, {}));
    const catalyst = new Catalyst({ clientId: "cid", clientSecret: "cs", fetch: mock.fetch });

    await expect(getCatalystV11Random({ client: catalyst.client })).rejects.toBeInstanceOf(AuthError);
    expect(mock.requests).toHaveLength(0);
  });

  it("failedRefreshReturnsOriginal401", async () => {
    const mock = mockFetch((req) => (isToken(req) ? json(400, { error: "invalid_grant" }) : json(401, {})));
    const catalyst = new Catalyst({
      clientId: "cid",
      clientSecret: "cs",
      accessToken: "at1",
      refreshToken: "rt1",
      fetch: mock.fetch,
    });

    const result = await getCatalystV11Random({ client: catalyst.client });

    expect(result.error).toBeInstanceOf(ApiError);
    expect(result.error!.status).toBe(401);
    expect(catalyst.accessToken).toBe("at1");
    expect(mock.requests.filter(isToken)).toHaveLength(1);
    expect(mock.requests.filter((r) => !isToken(r))).toHaveLength(1);
  });

  it("clearDuringRefreshIsNotOverwritten", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const refreshed: Token[] = [];
    const mock = mockFetch(async () => {
      await released;
      return json(200, tokenBody);
    });
    const catalyst = new Catalyst({
      clientId: "cid",
      clientSecret: "cs",
      accessToken: "at1",
      refreshToken: "rt1",
      fetch: mock.fetch,
      onTokenRefreshed: (token) => {
        refreshed.push(token);
      },
    });

    const refresh = catalyst.refresh();
    await expect.poll(() => mock.requests.length).toBe(1);
    catalyst.clearCredential();
    release();
    const token = await refresh;

    expect(token.accessToken).toBe("at2");
    expect(catalyst.accessToken).toBeUndefined();
    expect(catalyst.refreshToken).toBeUndefined();
    expect(refreshed).toHaveLength(0);
  });
});
