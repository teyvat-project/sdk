import CatalystSwift
import Foundation

/// Thread-safe mutable box for values shared between a test and `@Sendable` closures.
final class Box<Value>: @unchecked Sendable {
  private var value: Value
  private let lock = NSLock()

  init(_ value: Value) {
    self.value = value
  }

  func withLock<Result>(_ body: (inout Value) -> Result) -> Result {
    lock.lock()
    defer { lock.unlock() }
    return body(&value)
  }

  var current: Value { withLock { $0 } }
}

/// An `HTTPTransport` that records every request and answers through `responder`.
final class MockTransport: HTTPTransport {
  typealias Responder = @Sendable (ApiRequest) async throws -> ApiResponse

  private let recorded = Box<[ApiRequest]>([])
  private let responder: Responder

  init(_ responder: @escaping Responder) {
    self.responder = responder
  }

  var requests: [ApiRequest] { recorded.current }

  /// Requests to the token endpoint.
  var tokenRequests: [ApiRequest] { requests.filter(MockTransport.isToken) }

  /// Requests to anything but the token endpoint.
  var apiRequests: [ApiRequest] { requests.filter { !MockTransport.isToken($0) } }

  func send(_ request: ApiRequest) async throws -> ApiResponse {
    recorded.withLock { $0.append(request) }
    return try await responder(request)
  }

  static func isToken(_ request: ApiRequest) -> Bool {
    request.url.path == "/token"
  }

  static func json(_ status: Int, _ body: String, for request: ApiRequest) -> ApiResponse {
    ApiResponse(
      statusCode: status,
      headers: ["Content-Type": "application/json"],
      url: request.url,
      body: Data(body.utf8)
    )
  }
}

extension ApiRequest {
  var bodyText: String? { body.map { String(decoding: $0, as: UTF8.self) } }
}
