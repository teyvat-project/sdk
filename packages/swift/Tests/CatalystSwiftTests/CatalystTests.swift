import CatalystSwift
import XCTest

private let tokenBody = """
  {"access_token":"at2","refresh_token":"rt2","token_type":"Bearer","scope":"read write","expires_at":"2026-10-26T00:00:00Z","expires_in":3600}
  """

final class CatalystTests: XCTestCase {
  func testSendsBearerToken() async throws {
    let mock = MockTransport { MockTransport.json(200, "[]", for: $0) }
    let catalyst = Catalyst(clientId: "cid", clientSecret: "cs", accessToken: "at1", transport: mock)

    _ = try await catalyst.api.catalyst.getCatalystV1Gallery()

    XCTAssertEqual(mock.requests.count, 1)
    XCTAssertEqual(mock.requests[0].headers["Authorization"], "Bearer at1")
    XCTAssertEqual(mock.requests[0].headers["User-Agent"], "CatalystSwift")
  }

  func testRefreshesOn401AndRetries() async throws {
    let refreshed = Box<[Token]>([])
    let mock = MockTransport { request in
      if MockTransport.isToken(request) { return MockTransport.json(200, tokenBody, for: request) }
      return request.headers["Authorization"] == "Bearer at2"
        ? MockTransport.json(200, "[]", for: request)
        : MockTransport.json(401, "{}", for: request)
    }
    let catalyst = Catalyst(
      clientId: "cid",
      clientSecret: "cs",
      accessToken: "at1",
      refreshToken: "rt1",
      transport: mock,
      onTokenRefreshed: { token in refreshed.withLock { $0.append(token) } }
    )

    _ = try await catalyst.api.catalyst.getCatalystV1Gallery()

    XCTAssertEqual(mock.requests.count, 3)
    let tokenRequest = mock.requests[1]
    XCTAssertEqual(tokenRequest.url.absoluteString, "https://api.natsuneko.com/token")
    XCTAssertEqual(tokenRequest.method, .post)
    XCTAssertEqual(tokenRequest.headers["Content-Type"], "application/x-www-form-urlencoded")
    XCTAssertTrue(
      try XCTUnwrap(tokenRequest.bodyText).contains("grant_type=refresh_token&refresh_token=rt1&client_id=cid&client_secret=cs"))
    XCTAssertEqual(mock.requests[2].headers["Authorization"], "Bearer at2")
    XCTAssertEqual(refreshed.current.count, 1)
    XCTAssertEqual(refreshed.current.first?.accessToken, "at2")
    let accessToken = await catalyst.accessToken
    let refreshToken = await catalyst.refreshToken
    XCTAssertEqual(accessToken, "at2")
    XCTAssertEqual(refreshToken, "rt2")
  }

  func testConcurrent401sRefreshOnce() async throws {
    let mock = MockTransport { request in
      if MockTransport.isToken(request) {
        try await Task.sleep(nanoseconds: 20_000_000)
        return MockTransport.json(200, tokenBody, for: request)
      }
      return request.headers["Authorization"] == "Bearer at2"
        ? MockTransport.json(200, "[]", for: request)
        : MockTransport.json(401, "{}", for: request)
    }
    let catalyst = Catalyst(clientId: "cid", clientSecret: "cs", accessToken: "at1", refreshToken: "rt1", transport: mock)

    async let first = catalyst.api.catalyst.getCatalystV1Gallery()
    async let second = catalyst.api.catalyst.getCatalystV1Gallery()
    _ = try await (first, second)

    XCTAssertEqual(mock.tokenRequests.count, 1)
    XCTAssertEqual(mock.apiRequests.count, 4)
    XCTAssertEqual(mock.apiRequests.filter { $0.headers["Authorization"] == "Bearer at2" }.count, 2)
  }

  func testMissingTokenThrowsAuthError() async throws {
    let mock = MockTransport { MockTransport.json(200, "[]", for: $0) }
    let catalyst = Catalyst(clientId: "cid", clientSecret: "cs", transport: mock)

    do {
      _ = try await catalyst.api.catalyst.getCatalystV1Gallery()
      XCTFail("expected AuthError")
    } catch is AuthError {
    }
    XCTAssertEqual(mock.requests.count, 0)
  }

  func testFailedRefreshReturnsOriginal401() async throws {
    let mock = MockTransport { request in
      MockTransport.isToken(request)
        ? MockTransport.json(400, #"{"error":"invalid_grant"}"#, for: request)
        : MockTransport.json(401, "{}", for: request)
    }
    let catalyst = Catalyst(clientId: "cid", clientSecret: "cs", accessToken: "at1", refreshToken: "rt1", transport: mock)

    do {
      _ = try await catalyst.api.catalyst.getCatalystV1Gallery()
      XCTFail("expected ApiError")
    } catch let error as ApiError {
      XCTAssertEqual(error.statusCode, 401)
    }
    let accessToken = await catalyst.accessToken
    XCTAssertEqual(accessToken, "at1")
    XCTAssertEqual(mock.tokenRequests.count, 1)
    XCTAssertEqual(mock.apiRequests.count, 1)
  }
}
