using System.Globalization;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace CatalystSharp.Auth;

public enum OAuthErrorKind
{
    /// <summary>The authorization server answered the callback with an <c>error</c> parameter.</summary>
    AuthorizationRequestFailed,

    /// <summary>The callback URL does not match the expected redirect URI / state, or carries no <c>code</c>.</summary>
    InvalidAuthorizationResponse,

    /// <summary>The token endpoint answered with a non-2xx status or a body that is not a token response.</summary>
    InvalidTokenResponse,
}

public sealed class OAuthException : Exception
{
    public OAuthException(string message, OAuthErrorKind kind, string? error = null, string? errorDescription = null, string? errorUri = null)
        : base(message)
    {
        Kind = kind;
        Error = error;
        ErrorDescription = errorDescription;
        ErrorUri = errorUri;
    }

    public OAuthErrorKind Kind { get; }

    /// <summary>The <c>error</c> parameter of a failed authorization request.</summary>
    public string? Error { get; }

    public string? ErrorDescription { get; }

    public string? ErrorUri { get; }
}

public sealed class OAuthClient
{
    private static readonly Lazy<HttpClient> SharedHttpClient = new(() => new HttpClient(new SocketsHttpHandler
    {
        AllowAutoRedirect = false,
        UseCookies = false,
        PooledConnectionLifetime = TimeSpan.FromMinutes(5),
    }));

    private readonly string _clientId;
    private readonly string _clientSecret;
    private readonly string _baseUrl;
    private readonly string _authorizeEndpoint;
    private readonly HttpClient _httpClient;

    /// <param name="clientId">The OAuth client ID.</param>
    /// <param name="clientSecret">The OAuth client secret.</param>
    /// <param name="baseUrl">Base URL of the API; the token endpoint is <c>&lt;baseUrl&gt;/token</c>.</param>
    /// <param name="authorizeEndpoint">Authorization endpoint used by <see cref="GetAuthorizeUrl"/>; must be an absolute URL.</param>
    /// <param name="httpClient">Sends the token requests (default: a shared client).</param>
    public OAuthClient(string clientId, string clientSecret, string? baseUrl = null, string? authorizeEndpoint = null, HttpClient? httpClient = null)
    {
        _clientId = clientId ?? throw new ArgumentNullException(nameof(clientId));
        _clientSecret = clientSecret ?? throw new ArgumentNullException(nameof(clientSecret));
        _baseUrl = (baseUrl ?? Constants.PublicApiEndpoint).TrimEnd('/');
        _authorizeEndpoint = authorizeEndpoint ?? Constants.PublicAuthorizeEndpoint;
        _httpClient = httpClient ?? SharedHttpClient.Value;

        if (!Uri.TryCreate(_authorizeEndpoint, UriKind.Absolute, out _))
        {
            throw new ArgumentException("authorizeEndpoint must be an absolute URL.", nameof(authorizeEndpoint));
        }
    }

    public Uri GetAuthorizeUrl(string redirectUri, Pkce pkce, string state)
    {
        var query = FormEncode(
        [
            ("response_type", "code"),
            ("client_id", _clientId),
            ("redirect_uri", redirectUri),
            ("state", state),
            ("code_challenge", pkce.Challenge),
            ("code_challenge_method", pkce.Method),
        ]);
        return new Uri($"{new Uri(_authorizeEndpoint).GetLeftPart(UriPartial.Path)}?{query}");
    }

    /// <summary>Validates the callback URL and returns its authorization <c>code</c>.</summary>
    /// <exception cref="OAuthException">The callback does not match, carries an <c>error</c>, or has no <c>code</c>.</exception>
    public string GetAuthorizationCode(Uri callbackUrl, string expectedState, string expectedRedirectUri)
    {
        var text = callbackUrl.OriginalString;
        if (!text.StartsWith(expectedRedirectUri + "?", StringComparison.Ordinal))
        {
            throw new OAuthException("Invalid authorization response", OAuthErrorKind.InvalidAuthorizationResponse);
        }

        var query = ParseQuery(text);
        string? First(string name) => query.FirstOrDefault(pair => pair.Name == name).Value;

        if (First("state") != expectedState)
        {
            throw new OAuthException("Invalid authorization response", OAuthErrorKind.InvalidAuthorizationResponse);
        }

        if (First("error") is { } error)
        {
            throw new OAuthException("Authorization request failed", OAuthErrorKind.AuthorizationRequestFailed, error, First("error_description"), First("error_uri"));
        }

        return First("code") ?? throw new OAuthException("Invalid authorization response", OAuthErrorKind.InvalidAuthorizationResponse);
    }

    public Task<Token> GetAccessTokenByCodeAsync(string code, string redirectUri, Pkce pkce, CancellationToken cancellationToken = default)
        => PostTokenAsync(
        [
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirectUri),
            ("client_id", _clientId),
            ("code_verifier", pkce.Verifier),
        ], cancellationToken);

    public Task<Token> GetAccessTokenByRefreshTokenAsync(string refreshToken, CancellationToken cancellationToken = default)
        => PostTokenAsync(
        [
            ("grant_type", "refresh_token"),
            ("refresh_token", refreshToken),
            ("client_id", _clientId),
            ("client_secret", _clientSecret),
        ], cancellationToken);

    private async Task<Token> PostTokenAsync((string Name, string Value)[] form, CancellationToken cancellationToken)
    {
        // The form is pure ASCII, so the content type carries no charset.
        var content = new ByteArrayContent(Encoding.ASCII.GetBytes(FormEncode(form)));
        content.Headers.ContentType = new MediaTypeHeaderValue("application/x-www-form-urlencoded");
        using var request = new HttpRequestMessage(HttpMethod.Post, $"{_baseUrl}/token") { Content = content };
        // Token requests deliberately bypass the API client's middleware chain (no Authorization, no 401 retry).
        using var response = await _httpClient.SendAsync(request, cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            throw new OAuthException("Invalid token response", OAuthErrorKind.InvalidTokenResponse);
        }

        var body = await response.Content.ReadAsByteArrayAsync(cancellationToken).ConfigureAwait(false);
        return DecodeToken(body);
    }

    /// <summary>
    /// Only <c>access_token</c>, <c>refresh_token</c> and <c>token_type</c> are required. The other fields are optional,
    /// and a value of the wrong type (or an <c>expires_at</c> that is not an ISO 8601 date-time) counts as absent.
    /// </summary>
    private static Token DecodeToken(byte[] body)
    {
        try
        {
            using var document = JsonDocument.Parse(body);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) throw new OAuthException("Invalid token response", OAuthErrorKind.InvalidTokenResponse);

            return new Token(
                RequiredString(root, "access_token"),
                RequiredString(root, "refresh_token"),
                RequiredString(root, "token_type"),
                OptionalString(root, "scope"),
                OptionalString(root, "expires_at") is { } expiresAt && DateTimeOffset.TryParse(expiresAt, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out _) ? expiresAt : null,
                OptionalInt(root, "expires_in"));
        }
        catch (JsonException)
        {
            throw new OAuthException("Invalid token response", OAuthErrorKind.InvalidTokenResponse);
        }

        static string RequiredString(JsonElement root, string name)
            => OptionalString(root, name) ?? throw new OAuthException("Invalid token response", OAuthErrorKind.InvalidTokenResponse);

        static string? OptionalString(JsonElement root, string name)
            => root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

        static int? OptionalInt(JsonElement root, string name)
        {
            if (!root.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Number) return null;
            if (value.TryGetInt32(out var whole)) return whole;
            return value.TryGetDouble(out var number) && number == Math.Floor(number) && Math.Abs(number) <= int.MaxValue ? (int)number : null;
        }
    }

    // application/x-www-form-urlencoded, matching URLSearchParams: only A-Z a-z 0-9 * - . _ stay as they are, space is "+".
    private static string FormEncode((string Name, string Value)[] pairs)
        => string.Join('&', pairs.Select(pair => $"{FormEncodeComponent(pair.Name)}={FormEncodeComponent(pair.Value)}"));

    private static string FormEncodeComponent(string value)
    {
        var builder = new StringBuilder();
        foreach (var b in Encoding.UTF8.GetBytes(value))
        {
            var c = (char)b;
            if (char.IsAsciiLetterOrDigit(c) || c is '*' or '-' or '.' or '_') builder.Append(c);
            else if (c == ' ') builder.Append('+');
            else builder.Append('%').Append(b.ToString("X2", CultureInfo.InvariantCulture));
        }
        return builder.ToString();
    }

    /// <summary>The decoded <c>name=value</c> pairs of the query, in order (the fragment is ignored).</summary>
    private static List<(string Name, string Value)> ParseQuery(string url)
    {
        var hash = url.IndexOf('#');
        if (hash >= 0) url = url[..hash];
        var question = url.IndexOf('?');
        if (question < 0) return [];

        return url[(question + 1)..]
            .Split('&', StringSplitOptions.RemoveEmptyEntries)
            .Select(pair =>
            {
                var parts = pair.Split('=', 2);
                return (Decode(parts[0]), parts.Length > 1 ? Decode(parts[1]) : "");
            })
            .ToList();

        static string Decode(string text) => Uri.UnescapeDataString(text.Replace('+', ' '));
    }
}
