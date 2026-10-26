import CatalystAPI
import Foundation

public enum CatalystError: Error, Sendable, Equatable {
  /// `refresh()` was called while no refresh token was set.
  case noRefreshToken
}

public final class Catalyst: Sendable {
  public let api: ApiClient
  public let oauth: OAuth

  private let store: CredentialStore

  /// - Parameters:
  ///   - baseUrl: Defaults to `https://api.natsuneko.com`.
  ///   - middleware: Runs before the built-in User-Agent and 401-refresh middleware.
  ///   - transport: Replacement for the default `URLSession` transport, used for both API and token requests.
  ///   - onTokenRefreshed: Called after every successful token refresh. An error it throws propagates out of `refresh()`.
  public init(
    clientId: String,
    clientSecret: String,
    accessToken: String? = nil,
    refreshToken: String? = nil,
    baseUrl: String? = nil,
    middleware: [any Middleware] = [],
    transport: (any HTTPTransport)? = nil,
    onTokenRefreshed: (@Sendable (Token) async throws -> Void)? = nil
  ) {
    let baseUrl = baseUrl ?? Constants.publicApiEndpoint
    let oauth = OAuth(clientId: clientId, clientSecret: clientSecret, baseUrl: baseUrl, transport: transport)
    let api = ApiClient(options: ClientOptions(baseUrl: baseUrl, transport: transport))
    let store = CredentialStore(
      api: api,
      oauth: oauth,
      accessToken: accessToken,
      refreshToken: refreshToken,
      onTokenRefreshed: onTokenRefreshed
    )

    api.options.middleware =
      middleware + [
        UserAgentMiddleware(Constants.userAgent),
        Retry401Middleware { _, _ in await store.handleUnauthorized() },
      ]
    api.options.auth = store.makeAuth(for: accessToken)

    self.api = api
    self.oauth = oauth
    self.store = store
  }

  public var accessToken: String? {
    get async { await store.accessToken }
  }

  public var refreshToken: String? {
    get async { await store.refreshToken }
  }

  /// Replaces the credentials; a `nil` refresh token clears the stored one.
  public func setCredential(accessToken: String, refreshToken: String?) async {
    await store.setCredential(accessToken: accessToken, refreshToken: refreshToken)
  }

  public func clearCredential() async {
    await store.clearCredential()
  }

  /// Exchanges the refresh token for new credentials. Concurrent calls share a single request. If the credentials are
  /// set or cleared while the request is in flight, its token is returned but neither stored nor reported.
  public func refresh() async throws -> Token {
    try await store.refresh()
  }
}

/// Owns the mutable credentials and the in-flight refresh.
actor CredentialStore {
  private(set) var accessToken: String?
  private(set) var refreshToken: String?

  /// Bumped on every credential change, so a refresh that finishes after one does not overwrite it.
  private var generation = 0
  private var inflightRefresh: Task<Token, any Error>?
  private weak var api: ApiClient?
  private let oauth: OAuth
  private let onTokenRefreshed: (@Sendable (Token) async throws -> Void)?

  init(
    api: ApiClient,
    oauth: OAuth,
    accessToken: String?,
    refreshToken: String?,
    onTokenRefreshed: (@Sendable (Token) async throws -> Void)?
  ) {
    self.api = api
    self.oauth = oauth
    self.accessToken = accessToken
    self.refreshToken = refreshToken
    self.onTokenRefreshed = onTokenRefreshed
  }

  func setCredential(accessToken: String, refreshToken: String?) {
    self.accessToken = accessToken
    self.refreshToken = refreshToken
    generation += 1
    applyAuth()
  }

  func clearCredential() {
    accessToken = nil
    refreshToken = nil
    generation += 1
    applyAuth()
  }

  func refresh() async throws -> Token {
    if let inflightRefresh { return try await inflightRefresh.value }

    let task = Task { () throws -> Token in
      do {
        let token = try await self.performRefresh()
        self.inflightRefresh = nil
        return token
      } catch {
        self.inflightRefresh = nil
        throw error
      }
    }
    inflightRefresh = task
    return try await task.value
  }

  /// Backs `Retry401Middleware`: refreshes once and asks for a replay, or gives up and lets the 401 through.
  func handleUnauthorized() async -> Bool {
    guard let refreshToken, !refreshToken.isEmpty else { return false }
    do {
      _ = try await refresh()
      return true
    } catch {
      return false
    }
  }

  /// The auth for the generated client. The token is read through a provider on every send, because the generated
  /// runtime snapshots `ClientOptions` once per call: a replay after a 401 must still pick up the refreshed token.
  nonisolated func makeAuth(for accessToken: String?) -> ApiAuth? {
    guard let accessToken, !accessToken.isEmpty else { return nil }
    return ApiAuth(bearerAuth: TokenValue(provider: { try await self.currentAccessToken() }))
  }

  private func currentAccessToken() throws -> String {
    guard let accessToken, !accessToken.isEmpty else {
      throw AuthError("Missing credentials for security scheme(s): bearerAuth.", schemes: ["bearerAuth"])
    }
    return accessToken
  }

  private func performRefresh() async throws -> Token {
    guard let refreshToken, !refreshToken.isEmpty else { throw CatalystError.noRefreshToken }

    let generation = generation
    let token = try await oauth.getAccessTokenByRefreshToken(refreshToken)
    guard generation == self.generation else { return token }
    setCredential(accessToken: token.accessToken, refreshToken: token.refreshToken)
    try await onTokenRefreshed?(token)
    return token
  }

  private func applyAuth() {
    api?.options.auth = makeAuth(for: accessToken)
  }
}
