using System.Net;
using CatalystSharp.Api.Core;

namespace CatalystSharp.Tests;

public class CatalystTests
{
    private const string TokenBody =
        """{"access_token":"at2","refresh_token":"rt2","token_type":"Bearer","scope":"read write","expires_at":"2026-10-26T00:00:00Z","expires_in":3600}""";

    private static HttpResponseMessage Ok() => MockHandler.Json(HttpStatusCode.OK, "[]");

    [Fact]
    public async Task SendsBearerToken()
    {
        var mock = new MockHandler(_ => Ok());
        var catalyst = new Catalyst(new CatalystOptions
        {
            ClientId = "cid",
            ClientSecret = "cs",
            AccessToken = "at1",
            HttpClient = new HttpClient(mock),
        });

        await catalyst.Api.Catalyst.GetCatalystV1GalleryAsync();

        var request = Assert.Single(mock.Requests);
        Assert.Equal("Bearer at1", request.Header("Authorization"));
        Assert.Equal("CatalystSharp", request.Header("User-Agent"));
    }

    [Fact]
    public async Task RefreshesOn401AndRetries()
    {
        var refreshed = new List<Token>();
        var mock = new MockHandler(request =>
        {
            if (request.IsToken) return MockHandler.Json(HttpStatusCode.OK, TokenBody);
            return request.Header("Authorization") == "Bearer at2" ? Ok() : MockHandler.Json(HttpStatusCode.Unauthorized, "{}");
        });
        var catalyst = new Catalyst(new CatalystOptions
        {
            ClientId = "cid",
            ClientSecret = "cs",
            AccessToken = "at1",
            RefreshToken = "rt1",
            HttpClient = new HttpClient(mock),
            OnTokenRefreshed = token =>
            {
                lock (refreshed) refreshed.Add(token);
                return ValueTask.CompletedTask;
            },
        });

        await catalyst.Api.Catalyst.GetCatalystV1GalleryAsync();

        Assert.Equal(3, mock.Requests.Count);
        var tokenRequest = mock.Requests[1];
        Assert.Equal("https://api.natsuneko.com/token", tokenRequest.Url.AbsoluteUri);
        Assert.Equal(HttpMethod.Post, tokenRequest.Method);
        Assert.Equal("application/x-www-form-urlencoded", tokenRequest.Header("Content-Type"));
        Assert.Contains("grant_type=refresh_token&refresh_token=rt1&client_id=cid&client_secret=cs", tokenRequest.Body);
        Assert.Equal("Bearer at2", mock.Requests[2].Header("Authorization"));
        var token = Assert.Single(refreshed);
        Assert.Equal("at2", token.AccessToken);
        Assert.Equal("at2", catalyst.AccessToken);
        Assert.Equal("rt2", catalyst.RefreshToken);
    }

    [Fact]
    public async Task Concurrent401sRefreshOnce()
    {
        var unauthorized = 0;
        var bothUnauthorized = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var mock = new MockHandler(async request =>
        {
            if (request.IsToken)
            {
                // Hold the refresh until both calls have been rejected, so neither can start a second one.
                await bothUnauthorized.Task.WaitAsync(TimeSpan.FromSeconds(10));
                await Task.Delay(50);
                return MockHandler.Json(HttpStatusCode.OK, TokenBody);
            }
            if (request.Header("Authorization") == "Bearer at2") return Ok();
            if (Interlocked.Increment(ref unauthorized) == 2) bothUnauthorized.TrySetResult();
            return MockHandler.Json(HttpStatusCode.Unauthorized, "{}");
        });
        var catalyst = new Catalyst(new CatalystOptions
        {
            ClientId = "cid",
            ClientSecret = "cs",
            AccessToken = "at1",
            RefreshToken = "rt1",
            HttpClient = new HttpClient(mock),
        });

        var first = catalyst.Api.Catalyst.GetCatalystV1GalleryAsync();
        var second = catalyst.Api.Catalyst.GetCatalystV1GalleryAsync();
        await Task.WhenAll(first, second);

        Assert.Single(mock.TokenRequests);
        Assert.Equal(4, mock.ApiRequests.Count);
        Assert.Equal(2, mock.ApiRequests.Count(r => r.Header("Authorization") == "Bearer at2"));
    }

    [Fact]
    public async Task MissingTokenThrowsAuthError()
    {
        var mock = new MockHandler(_ => Ok());
        var catalyst = new Catalyst(new CatalystOptions { ClientId = "cid", ClientSecret = "cs", HttpClient = new HttpClient(mock) });

        await Assert.ThrowsAsync<ApiAuthException>(() => catalyst.Api.Catalyst.GetCatalystV1GalleryAsync());

        Assert.Empty(mock.Requests);
    }

    [Fact]
    public async Task FailedRefreshReturnsOriginal401()
    {
        var mock = new MockHandler(request => request.IsToken
            ? MockHandler.Json(HttpStatusCode.BadRequest, """{"error":"invalid_grant"}""")
            : MockHandler.Json(HttpStatusCode.Unauthorized, "{}"));
        var catalyst = new Catalyst(new CatalystOptions
        {
            ClientId = "cid",
            ClientSecret = "cs",
            AccessToken = "at1",
            RefreshToken = "rt1",
            HttpClient = new HttpClient(mock),
        });

        var error = await Assert.ThrowsAnyAsync<ApiException>(() => catalyst.Api.Catalyst.GetCatalystV1GalleryAsync());

        Assert.Equal(401, error.StatusCode);
        Assert.Equal("at1", catalyst.AccessToken);
        Assert.Single(mock.TokenRequests);
        Assert.Single(mock.ApiRequests);
    }
}
