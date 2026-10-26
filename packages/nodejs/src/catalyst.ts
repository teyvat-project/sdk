import {
  createApiClient,
  retry401Middleware,
  userAgentMiddleware,
  type ApiAuth,
  type Client,
  type FetchLike,
  type Middleware,
} from "./generated/index.js";
import { OAuth } from "./oauth/oauth.js";
import { PUBLIC_API_ENDPOINT, USER_AGENT } from "./types/constants.js";
import type { Token } from "./types/token.js";

export interface CatalystOptions {
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  refreshToken?: string;
  /** Defaults to `https://api.natsuneko.com`. */
  baseUrl?: string;
  /** Runs before the built-in User-Agent and 401-refresh middleware. */
  middleware?: Middleware[];
  /** Replacement for the global `fetch`, used for both API and token requests. */
  fetch?: FetchLike;
  /** Called after every successful token refresh. */
  onTokenRefreshed?: (token: Token) => void | Promise<void>;
}

export class Catalyst {
  readonly client: Client<ApiAuth>;
  readonly oauth: OAuth;

  #accessToken: string | undefined;
  #refreshToken: string | undefined;
  #inflightRefresh: Promise<Token> | undefined;
  readonly #onTokenRefreshed: CatalystOptions["onTokenRefreshed"];

  constructor(opts: CatalystOptions) {
    const baseUrl = opts.baseUrl ?? PUBLIC_API_ENDPOINT;
    this.#onTokenRefreshed = opts.onTokenRefreshed;

    this.oauth = new OAuth(opts.clientId, opts.clientSecret, { baseUrl, fetch: opts.fetch });
    this.client = createApiClient({
      baseUrl,
      fetch: opts.fetch,
      middleware: [
        ...(opts.middleware ?? []),
        userAgentMiddleware(USER_AGENT),
        retry401Middleware({ onUnauthorized: () => this.#onUnauthorized() }),
      ],
    });

    this.#accessToken = opts.accessToken;
    this.#refreshToken = opts.refreshToken;
    this.#applyAuth();
  }

  get accessToken(): string | undefined {
    return this.#accessToken;
  }

  get refreshToken(): string | undefined {
    return this.#refreshToken;
  }

  setCredential(accessToken: string, refreshToken?: string): void {
    this.#accessToken = accessToken;
    this.#refreshToken = refreshToken;
    this.#applyAuth();
  }

  clearCredential(): void {
    this.#accessToken = undefined;
    this.#refreshToken = undefined;
    this.#applyAuth();
  }

  /** Exchanges the refresh token for new credentials. Concurrent calls share a single request. */
  refresh(): Promise<Token> {
    this.#inflightRefresh ??= this.#performRefresh().finally(() => {
      this.#inflightRefresh = undefined;
    });
    return this.#inflightRefresh;
  }

  async #performRefresh(): Promise<Token> {
    const refreshToken = this.#refreshToken;
    if (refreshToken === undefined || refreshToken === "") {
      throw new Error("No refresh token is available");
    }

    const token = await this.oauth.getAccessTokenByRefreshToken(refreshToken);
    this.setCredential(token.accessToken, token.refreshToken);
    await this.#onTokenRefreshed?.(token);
    return token;
  }

  async #onUnauthorized(): Promise<boolean> {
    if (this.#refreshToken === undefined || this.#refreshToken === "") return false;
    try {
      await this.refresh();
      return true;
    } catch {
      return false;
    }
  }

  #applyAuth(): void {
    const token = this.#accessToken;
    this.client.setConfig({ auth: token === undefined || token === "" ? undefined : { bearerAuth: token } });
  }
}
