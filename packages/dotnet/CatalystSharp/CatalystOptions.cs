using CatalystSharp.Api.Core;

namespace CatalystSharp;

public sealed class CatalystOptions
{
    public required string ClientId { get; init; }

    public required string ClientSecret { get; init; }

    public string? AccessToken { get; init; }

    public string? RefreshToken { get; init; }

    /// <summary>Defaults to <c>https://api.natsuneko.com</c>.</summary>
    public string BaseUrl { get; init; } = Constants.PublicApiEndpoint;

    /// <summary>Runs before the built-in User-Agent and 401-refresh middleware.</summary>
    public IList<IApiMiddleware> Middleware { get; init; } = new List<IApiMiddleware>();

    /// <summary>
    /// Replacement for the default <see cref="System.Net.Http.HttpClient"/>, used for both API and token requests.
    /// Its handler should not follow redirects (<c>AllowAutoRedirect = false</c>).
    /// </summary>
    public HttpClient? HttpClient { get; init; }

    /// <summary>Called after every successful token refresh. An exception it throws propagates out of <see cref="Catalyst.RefreshAsync"/>.</summary>
    public Func<Token, ValueTask>? OnTokenRefreshed { get; init; }
}
