using CatalystSharp.Api;
using CatalystSharp.Api.Core;
using CatalystSharp.Auth;

namespace CatalystSharp;

public sealed class Catalyst
{
    private readonly object _credentialLock = new();
    private readonly SemaphoreSlim _refreshGate = new(1, 1);
    private readonly Func<Token, ValueTask>? _onTokenRefreshed;
    private string? _accessToken;
    private string? _refreshToken;
    private int _generation; // bumped on every credential change, so a refresh that finishes after one does not overwrite it
    private Task<Token>? _inflightRefresh;

    public Catalyst(CatalystOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        _onTokenRefreshed = options.OnTokenRefreshed;

        OAuth = new OAuthClient(options.ClientId, options.ClientSecret, options.BaseUrl, httpClient: options.HttpClient);

        var apiOptions = new ApiClientOptions { BaseUrl = options.BaseUrl, HttpClient = options.HttpClient };
        apiOptions.Middleware.AddRange(options.Middleware);
        apiOptions.Middleware.Add(new UserAgentMiddleware(Constants.UserAgent));
        apiOptions.Middleware.Add(new Retry401Middleware((_, _, cancellationToken) => OnUnauthorizedAsync(cancellationToken)));
        Api = new ApiClient(apiOptions);

        _accessToken = options.AccessToken;
        _refreshToken = options.RefreshToken;
        ApplyAuth();
    }

    /// <summary>The generated API client.</summary>
    public ApiClient Api { get; }

    public OAuthClient OAuth { get; }

    public string? AccessToken
    {
        get
        {
            lock (_credentialLock) return _accessToken;
        }
    }

    public string? RefreshToken
    {
        get
        {
            lock (_credentialLock) return _refreshToken;
        }
    }

    /// <summary>Replaces the credentials; a <c>null</c> refresh token clears the stored one.</summary>
    public void SetCredential(string accessToken, string? refreshToken = null)
    {
        ArgumentNullException.ThrowIfNull(accessToken);
        lock (_credentialLock)
        {
            _accessToken = accessToken;
            _refreshToken = refreshToken;
            _generation++;
            ApplyAuth();
        }
    }

    public void ClearCredential()
    {
        lock (_credentialLock)
        {
            _accessToken = null;
            _refreshToken = null;
            _generation++;
            ApplyAuth();
        }
    }

    /// <summary>
    /// Exchanges the refresh token for new credentials. Concurrent calls share a single request. The cancellation token
    /// only stops this call from waiting; the shared request keeps running for the other callers. If the credentials are
    /// set or cleared while the request is in flight, its token is returned but neither stored nor reported.
    /// </summary>
    /// <exception cref="InvalidOperationException">No refresh token is available.</exception>
    public async Task<Token> RefreshAsync(CancellationToken cancellationToken = default)
    {
        Task<Token> refresh;
        await _refreshGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            refresh = _inflightRefresh ??= RunRefreshAsync();
        }
        finally
        {
            _refreshGate.Release();
        }
        return await refresh.WaitAsync(cancellationToken).ConfigureAwait(false);
    }

    private async Task<Token> RunRefreshAsync()
    {
        try
        {
            return await PerformRefreshAsync().ConfigureAwait(false);
        }
        finally
        {
            // The creator holds the gate until _inflightRefresh is assigned, so this cannot run (and clear it) too early.
            await _refreshGate.WaitAsync().ConfigureAwait(false);
            _inflightRefresh = null;
            _refreshGate.Release();
        }
    }

    private async Task<Token> PerformRefreshAsync()
    {
        string? refreshToken;
        int generation;
        lock (_credentialLock)
        {
            refreshToken = _refreshToken;
            generation = _generation;
        }
        if (string.IsNullOrEmpty(refreshToken)) throw new InvalidOperationException("No refresh token is available");

        var token = await OAuth.GetAccessTokenByRefreshTokenAsync(refreshToken).ConfigureAwait(false);
        lock (_credentialLock)
        {
            if (generation != _generation) return token;
            SetCredential(token.AccessToken, token.RefreshToken);
        }
        if (_onTokenRefreshed is { } callback) await callback(token).ConfigureAwait(false);
        return token;
    }

    /// <summary>Backs <see cref="Retry401Middleware"/>: refreshes once and asks for a replay, or gives up and lets the 401 through.</summary>
    private async ValueTask<bool> OnUnauthorizedAsync(CancellationToken cancellationToken)
    {
        if (string.IsNullOrEmpty(RefreshToken)) return false;
        try
        {
            await RefreshAsync(cancellationToken).ConfigureAwait(false);
            return true;
        }
        catch (Exception) when (!cancellationToken.IsCancellationRequested)
        {
            return false;
        }
    }

    /// <summary>
    /// The generated runtime reads <c>Options.Auth</c> on every send (replays included), so replacing it is enough for a
    /// replay after a 401 to carry the new token. An empty token means no auth at all: the runtime then fails with
    /// <see cref="ApiAuthException"/> before sending, rather than sending an empty bearer header.
    /// </summary>
    private void ApplyAuth()
    {
        var token = _accessToken;
        Api.Options.Auth = string.IsNullOrEmpty(token) ? null : new ApiAuth { BearerAuth = new TokenValue(token) };
    }
}
