// The "Usage" example from README.md, kept here so `tsc` checks it; readme.test.ts keeps the two in sync.
import { Catalyst } from "../src/index.js";

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
