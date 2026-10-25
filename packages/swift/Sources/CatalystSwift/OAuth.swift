import CatalystAPI
import Foundation

public enum OAuthError: Error, Sendable, Equatable {
  /// The authorization server answered the callback with an `error` parameter.
  case authorizationRequestFailed(error: String, description: String?, uri: String?)
  /// The callback URL does not match the expected redirect URI / state, or carries no `code`.
  case invalidAuthorizationResponse
  /// The token endpoint answered with a non-2xx status or a body that is not a token response.
  case invalidTokenResponse
}

public final class OAuth: Sendable {
  private let clientId: String
  private let clientSecret: String
  private let baseUrl: String
  private let authorizeEndpoint: String
  private let transport: any HTTPTransport

  /// - Parameters:
  ///   - baseUrl: Base URL of the API; the token endpoint is `<baseUrl>/token`.
  ///   - authorizeEndpoint: Authorization endpoint used by `getAuthorizeURL`; must be an absolute URL.
  ///   - transport: Sends the token requests (default: a shared `URLSession` transport).
  public init(
    clientId: String,
    clientSecret: String,
    baseUrl: String? = nil,
    authorizeEndpoint: String? = nil,
    transport: (any HTTPTransport)? = nil
  ) {
    var base = baseUrl ?? Constants.publicApiEndpoint
    while base.hasSuffix("/") { base.removeLast() }
    let authorize = authorizeEndpoint ?? Constants.publicAuthorizeEndpoint
    precondition(URLComponents(string: authorize) != nil, "authorizeEndpoint must be a valid URL")

    self.clientId = clientId
    self.clientSecret = clientSecret
    self.baseUrl = base
    self.authorizeEndpoint = authorize
    self.transport = transport ?? URLSessionTransport.shared
  }

  public func getAccessTokenByCode(code: String, redirectUri: String, pkce: PKCE) async throws -> Token {
    try await postToken([
      ("grant_type", "authorization_code"),
      ("code", code),
      ("redirect_uri", redirectUri),
      ("client_id", clientId),
      ("code_verifier", pkce.verifier),
    ])
  }

  public func getAccessTokenByRefreshToken(_ refreshToken: String) async throws -> Token {
    try await postToken([
      ("grant_type", "refresh_token"),
      ("refresh_token", refreshToken),
      ("client_id", clientId),
      ("client_secret", clientSecret),
    ])
  }

  public func getAuthorizeURL(redirectUri: String, pkce: PKCE, state: String) -> URL {
    var components = URLComponents(string: authorizeEndpoint)!
    components.percentEncodedQuery = FormEncoding.encode([
      ("response_type", "code"),
      ("client_id", clientId),
      ("redirect_uri", redirectUri),
      ("state", state),
      ("code_challenge", pkce.challenge),
      ("code_challenge_method", pkce.method),
    ])
    return components.url!
  }

  public func getAuthorizationCode(callbackUrl: URL, expectedState: String, expectedRedirectUri: String) throws -> String {
    guard callbackUrl.absoluteString.hasPrefix(expectedRedirectUri + "?") else {
      throw OAuthError.invalidAuthorizationResponse
    }

    let query = FormEncoding.parseQuery(of: callbackUrl)
    func first(_ name: String) -> String? { query.first { $0.0 == name }?.1 }

    guard first("state") == expectedState else { throw OAuthError.invalidAuthorizationResponse }

    if let error = first("error") {
      throw OAuthError.authorizationRequestFailed(
        error: error,
        description: first("error_description"),
        uri: first("error_uri")
      )
    }

    guard let code = first("code") else { throw OAuthError.invalidAuthorizationResponse }
    return code
  }

  private func postToken(_ form: [(String, String)]) async throws -> Token {
    let request = ApiRequest(
      method: .post,
      url: try ApiURL.make("\(baseUrl)/token"),
      headers: ["Content-Type": "application/x-www-form-urlencoded"],
      body: Data(FormEncoding.encode(form).utf8)
    )

    let response = try await transport.send(request)
    guard (200..<300).contains(response.statusCode) else { throw OAuthError.invalidTokenResponse }

    let decoded: AccessTokenResponse
    do {
      decoded = try ApiJSON.decode(AccessTokenResponse.self, from: response.body)
    } catch {
      throw OAuthError.invalidTokenResponse
    }

    return Token(
      accessToken: decoded.accessToken,
      refreshToken: decoded.refreshToken,
      tokenType: decoded.tokenType.rawValue,
      scope: decoded.scope.rawValue,
      expiresAt: decoded.expiresAt,
      expiresIn: decoded.expiresIn
    )
  }
}

/// `application/x-www-form-urlencoded` encoding and decoding, matching `URLSearchParams`.
enum FormEncoding {
  private static let unreserved = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789*-._".utf8)

  static func encode(_ pairs: [(String, String)]) -> String {
    pairs.map { "\(component($0.0))=\(component($0.1))" }.joined(separator: "&")
  }

  static func component(_ value: String) -> String {
    var out = ""
    for byte in value.utf8 {
      if unreserved.contains(byte) {
        out.unicodeScalars.append(Unicode.Scalar(byte))
      } else if byte == 0x20 {
        out += "+"
      } else {
        out += "%" + String(byte, radix: 16, uppercase: true).leftPadded(to: 2)
      }
    }
    return out
  }

  /// The decoded `name=value` pairs of `url`'s query, in order.
  static func parseQuery(of url: URL) -> [(String, String)] {
    var text = url.absoluteString
    if let hash = text.firstIndex(of: "#") { text = String(text[..<hash]) }
    guard let question = text.firstIndex(of: "?") else { return [] }

    return text[text.index(after: question)...]
      .split(separator: "&", omittingEmptySubsequences: true)
      .map { pair in
        let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
        return (decode(parts[0]), parts.count > 1 ? decode(parts[1]) : "")
      }
  }

  private static func decode(_ text: Substring) -> String {
    let spaced = text.replacingOccurrences(of: "+", with: " ")
    return spaced.removingPercentEncoding ?? spaced
  }
}

extension String {
  fileprivate func leftPadded(to length: Int) -> String {
    count >= length ? self : String(repeating: "0", count: length - count) + self
  }
}
