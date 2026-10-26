import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ApiError,
  Catalyst,
  createApiClient,
  createFacade,
  getCatalystV11TimelineHome,
  type Facade,
} from "../src/index.js";

interface Recorded {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
}

function mockFetch(respond: (req: Recorded) => Response = () => json(200, {})) {
  const requests: Recorded[] = [];
  const fetchImpl = async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const req: Recorded = {
      url: input.toString(),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    requests.push(req);
    return respond(req);
  };
  return { fetch: fetchImpl, requests };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const newCatalyst = (fetch: ReturnType<typeof mockFetch>["fetch"]) =>
  new Catalyst({ clientId: "cid", clientSecret: "cs", accessToken: "at1", fetch });

describe("nested API", () => {
  it("homeTimelineSendsGetWithBearerToken", async () => {
    const mock = mockFetch();
    const catalyst = newCatalyst(mock.fetch);

    const result = await catalyst.catalyst.v11.timeline.home.get();

    expect(result.error).toBeUndefined();
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]!.method).toBe("GET");
    expect(mock.requests[0]!.url).toBe("https://api.natsuneko.com/catalyst/v1.1/timeline/home");
    expect(mock.requests[0]!.headers.get("Authorization")).toBe("Bearer at1");
  });

  it("pathParamsBuildTheUrl", async () => {
    const mock = mockFetch();
    const catalyst = newCatalyst(mock.fetch);

    await catalyst.catalyst.v11.status.id.get({ path: { id: "status/1" } });

    expect(mock.requests[0]!.url).toBe("https://api.natsuneko.com/catalyst/v1.1/status/status%2F1");
  });

  it("createSendsTheBody", async () => {
    const mock = mockFetch();
    const catalyst = newCatalyst(mock.fetch);

    await catalyst.catalyst.v1.relationships.bulk.create({ body: { userIds: ["u1", "u2"] } });

    expect(mock.requests[0]!.method).toBe("POST");
    expect(mock.requests[0]!.url).toBe("https://api.natsuneko.com/catalyst/v1/relationships/bulk");
    expect(JSON.parse(mock.requests[0]!.body!)).toEqual({ userIds: ["u1", "u2"] });
  });

  it("throwOnErrorPassesThrough", async () => {
    const ok = newCatalyst(mockFetch(() => json(200, { id: "1" })).fetch);
    const thrown = await ok.catalyst.v11.timeline.home.get({ throwOnError: true });
    expectTypeOf(thrown).toEqualTypeOf<Awaited<ReturnType<typeof getCatalystV11TimelineHome<true>>>>();
    expectTypeOf(thrown.data).not.toEqualTypeOf<undefined>();

    const returned = await ok.catalyst.v11.timeline.home.get();
    expectTypeOf(returned).toEqualTypeOf<Awaited<ReturnType<typeof getCatalystV11TimelineHome<false>>>>();

    const failing = newCatalyst(mockFetch(() => json(500, { message: "boom" })).fetch);
    await expect(failing.catalyst.v11.timeline.home.get({ throwOnError: true })).rejects.toBeInstanceOf(ApiError);
    const result = await failing.catalyst.v11.timeline.home.get();
    expect(result.error).toBeInstanceOf(ApiError);
  });

  it("requiredOptionsStayRequired", () => {
    const catalyst = newCatalyst(mockFetch().fetch);
    // @ts-expect-error `path` is required, so options cannot be omitted.
    void (() => catalyst.catalyst.v11.status.id.get());
    // @ts-expect-error the facade always passes its own client.
    void (() => catalyst.catalyst.v11.timeline.home.get({ client: catalyst.client }));
  });

  it("credentialChangesApplyToTheFacade", async () => {
    const mock = mockFetch();
    const catalyst = newCatalyst(mock.fetch);
    const home = catalyst.catalyst.v11.timeline.home;

    catalyst.setCredential("at2");
    await home.get();

    expect(mock.requests[0]!.headers.get("Authorization")).toBe("Bearer at2");
  });

  it("servicesAreBuiltOnce", () => {
    const catalyst = newCatalyst(mockFetch().fetch);
    expect(catalyst.catalyst).toBe(catalyst.catalyst);
    expect(catalyst.featureFlags).toBe(catalyst.featureFlags);
  });

  it("catalystExposesEveryService", () => {
    const catalyst = newCatalyst(mockFetch().fetch);
    const services = Object.keys(createFacade(createApiClient())) as (keyof Facade)[];

    expect(services.sort()).toEqual(["catalyst", "egeria", "epiclese", "featureFlags", "giftia", "media", "steambird"]);
    for (const service of services) expect(catalyst[service]).toBeDefined();
    expectTypeOf<keyof Facade>().toExtend<keyof Catalyst>();
    expectTypeOf(catalyst.featureFlags).toEqualTypeOf<Facade["featureFlags"]>();
  });
});
