using System.Security.Cryptography;
using System.Text;

namespace CatalystSharp.Auth;

/// <summary>A PKCE (RFC 7636) verifier / challenge pair using the <c>S256</c> method.</summary>
public sealed class Pkce
{
    private Pkce(string verifier, string challenge)
    {
        Verifier = verifier;
        Challenge = challenge;
    }

    public string Verifier { get; }

    public string Challenge { get; }

    public string Method => "S256";

    /// <summary>Creates a pair from 32 random bytes.</summary>
    public static Pkce Create() => FromVerifier(Base64UrlEncode(RandomNumberGenerator.GetBytes(32)));

    /// <summary>Builds a pair from a known verifier (e.g. for tests against RFC 7636 vectors).</summary>
    public static Pkce FromVerifier(string verifier)
    {
        ArgumentNullException.ThrowIfNull(verifier);
        return new Pkce(verifier, Base64UrlEncode(SHA256.HashData(Encoding.UTF8.GetBytes(verifier))));
    }

    private static string Base64UrlEncode(byte[] bytes)
        => Convert.ToBase64String(bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=');
}
