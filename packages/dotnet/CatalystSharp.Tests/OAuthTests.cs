using System.Net;
using System.Web;
using CatalystSharp.Auth;

namespace CatalystSharp.Tests;

public class OAuthTests
{
    [Fact]
    public void PkceMatchesRfc7636Vector()
    {
        var pkce = Pkce.FromVerifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");

        Assert.Equal("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", pkce.Challenge);
        Assert.Equal("S256", pkce.Method);
    }

    [Fact]
    public void AuthorizeUrlHasParams()
    {
        var oauth = new OAuthClient("cid", "cs");
        var pkce = Pkce.Create();

        var url = oauth.GetAuthorizeUrl("app://cb", pkce, "st");

        Assert.Equal("https://accounts.natsuneko.com/authorize", url.GetLeftPart(UriPartial.Path));
        var query = HttpUtility.ParseQueryString(url.Query);
        Assert.Equal("code", query["response_type"]);
        Assert.Equal("cid", query["client_id"]);
        Assert.Equal("app://cb", query["redirect_uri"]);
        Assert.Equal("st", query["state"]);
        Assert.Equal(pkce.Challenge, query["code_challenge"]);
        Assert.Equal("S256", query["code_challenge_method"]);
    }

    [Fact]
    public void AuthorizationCodeRejectsStateMismatch()
    {
        var oauth = new OAuthClient("cid", "cs");

        var error = Assert.Throws<OAuthException>(() => oauth.GetAuthorizationCode(new Uri("app://cb?code=c&state=other"), "st", "app://cb"));

        Assert.Equal(OAuthErrorKind.InvalidAuthorizationResponse, error.Kind);
        Assert.Equal("c", oauth.GetAuthorizationCode(new Uri("app://cb?code=c&state=st"), "st", "app://cb"));
    }

    [Fact]
    public async Task TokenResponseWithOnlyRequiredFields()
    {
        var mock = new MockHandler(_ => MockHandler.Json(
            HttpStatusCode.OK, """{"access_token":"at","refresh_token":"rt","token_type":"Bearer","expires_at":"not-a-date"}"""));
        var oauth = new OAuthClient("cid", "cs", httpClient: new HttpClient(mock));

        var token = await oauth.GetAccessTokenByRefreshTokenAsync("rt0");

        Assert.Equal("at", token.AccessToken);
        Assert.Equal("rt", token.RefreshToken);
        Assert.Equal("Bearer", token.TokenType);
        Assert.Null(token.Scope);
        Assert.Null(token.ExpiresAt);
        Assert.Null(token.ExpiresIn);

        var incomplete = new MockHandler(_ => MockHandler.Json(HttpStatusCode.OK, """{"access_token":"at","token_type":"Bearer"}"""));
        var error = await Assert.ThrowsAsync<OAuthException>(
            () => new OAuthClient("cid", "cs", httpClient: new HttpClient(incomplete)).GetAccessTokenByRefreshTokenAsync("rt0"));
        Assert.Equal(OAuthErrorKind.InvalidTokenResponse, error.Kind);
    }
}
