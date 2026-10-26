import CryptoKit
import Foundation

/// A PKCE (RFC 7636) verifier / challenge pair using the S256 method.
public struct PKCE: Sendable, Hashable {
  public let verifier: String
  public let challenge: String
  public let method = "S256"

  private init(verifier: String) {
    self.verifier = verifier
    self.challenge = PKCE.base64url(Data(SHA256.hash(data: Data(verifier.utf8))))
  }

  /// Creates a pair from 32 random bytes.
  public static func create() -> PKCE {
    var generator = SystemRandomNumberGenerator()
    let bytes = (0..<32).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
    return PKCE(verifier: base64url(Data(bytes)))
  }

  /// Builds a PKCE pair from a known verifier (e.g. for tests against RFC 7636 vectors).
  public static func fromVerifier(_ verifier: String) -> PKCE {
    PKCE(verifier: verifier)
  }

  private static func base64url(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}
