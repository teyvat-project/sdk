namespace CatalystSharp;

/// <summary>The result of a token exchange.</summary>
/// <param name="AccessToken">The access token.</param>
/// <param name="RefreshToken">The refresh token.</param>
/// <param name="TokenType">The token type (e.g. <c>Bearer</c>).</param>
/// <param name="Scope">Present on responses from the real token-exchange endpoint (e.g. <c>read write</c>).</param>
/// <param name="ExpiresAt">ISO 8601 timestamp for when the access token expires.</param>
/// <param name="ExpiresIn">Seconds until the access token expires.</param>
public sealed record Token(
    string AccessToken,
    string RefreshToken,
    string TokenType,
    string? Scope = null,
    string? ExpiresAt = null,
    int? ExpiresIn = null);
