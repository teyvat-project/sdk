import CatalystSwift
import XCTest

final class OAuthTests: XCTestCase {
  func testPkceMatchesRfc7636Vector() async throws {
    let pkce = PKCE.fromVerifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")

    XCTAssertEqual(pkce.challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    XCTAssertEqual(pkce.method, "S256")
  }

  func testAuthorizeUrlHasParams() async throws {
    let oauth = OAuth(clientId: "cid", clientSecret: "cs")
    let pkce = PKCE.create()

    let url = oauth.getAuthorizeURL(redirectUri: "app://cb", pkce: pkce, state: "st")

    let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
    XCTAssertEqual("\(components.scheme ?? "")://\(components.host ?? "")\(components.path)", "https://accounts.natsuneko.com/authorize")
    var query: [String: String] = [:]
    for item in components.queryItems ?? [] { query[item.name] = item.value }
    XCTAssertEqual(query["response_type"], "code")
    XCTAssertEqual(query["client_id"], "cid")
    XCTAssertEqual(query["redirect_uri"], "app://cb")
    XCTAssertEqual(query["state"], "st")
    XCTAssertEqual(query["code_challenge"], pkce.challenge)
    XCTAssertEqual(query["code_challenge_method"], "S256")
  }

  func testAuthorizationCodeRejectsStateMismatch() async throws {
    let oauth = OAuth(clientId: "cid", clientSecret: "cs")

    do {
      _ = try oauth.getAuthorizationCode(
        callbackUrl: try XCTUnwrap(URL(string: "app://cb?code=c&state=other")),
        expectedState: "st",
        expectedRedirectUri: "app://cb"
      )
      XCTFail("expected OAuthError.invalidAuthorizationResponse")
    } catch OAuthError.invalidAuthorizationResponse {
    }

    let code = try oauth.getAuthorizationCode(
      callbackUrl: try XCTUnwrap(URL(string: "app://cb?code=c&state=st")),
      expectedState: "st",
      expectedRedirectUri: "app://cb"
    )
    XCTAssertEqual(code, "c")
  }
}
