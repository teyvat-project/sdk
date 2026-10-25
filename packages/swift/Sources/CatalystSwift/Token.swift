import Foundation

public struct Token: Sendable, Hashable {
  public var accessToken: String
  public var refreshToken: String
  public var tokenType: String
  /// Present on responses from the real token-exchange endpoint (e.g. "read write").
  public var scope: String?
  /// When the access token expires.
  public var expiresAt: Date?
  /// Seconds until the access token expires.
  public var expiresIn: Double?

  public init(
    accessToken: String,
    refreshToken: String,
    tokenType: String,
    scope: String? = nil,
    expiresAt: Date? = nil,
    expiresIn: Double? = nil
  ) {
    self.accessToken = accessToken
    self.refreshToken = refreshToken
    self.tokenType = tokenType
    self.scope = scope
    self.expiresAt = expiresAt
    self.expiresIn = expiresIn
  }
}
