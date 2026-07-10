using System.Security.Cryptography;
using System.Text;

namespace WorldMap.Core.Auth;

/// <summary>
/// Computes and verifies the federation HMAC-SHA256 signature:
/// <c>base64url(HMAC-SHA256(utf8(canonicalString), secret))</c> using URL-safe
/// base64 WITHOUT padding. Verification is constant-time.
/// </summary>
public static class HmacSigner
{
    /// <summary>Computes the base64url (unpadded) signature for a canonical string and secret.</summary>
    public static string Sign(string canonicalString, string secret)
    {
        var key = Encoding.UTF8.GetBytes(secret);
        var data = Encoding.UTF8.GetBytes(canonicalString);
        var mac = HMACSHA256.HashData(key, data);
        return Base64UrlEncode(mac);
    }

    /// <summary>
    /// Constant-time comparison of a presented base64url signature against the one
    /// recomputed from <paramref name="canonicalString"/> and <paramref name="secret"/>.
    /// Returns false on any decoding failure rather than throwing.
    /// </summary>
    public static bool Verify(string canonicalString, string secret, string presentedSignature)
    {
        var key = Encoding.UTF8.GetBytes(secret);
        var data = Encoding.UTF8.GetBytes(canonicalString);
        var expected = HMACSHA256.HashData(key, data);

        if (!TryBase64UrlDecode(presentedSignature, out var presented))
        {
            // Still burn a comparison against a fixed-length buffer to avoid leaking
            // decode-failure timing, then reject.
            CryptographicOperations.FixedTimeEquals(expected, expected);
            return false;
        }

        return CryptographicOperations.FixedTimeEquals(expected, presented);
    }

    public static string Base64UrlEncode(ReadOnlySpan<byte> bytes)
    {
        var s = Convert.ToBase64String(bytes);
        return s.TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    private static bool TryBase64UrlDecode(string value, out byte[] bytes)
    {
        bytes = [];
        if (string.IsNullOrEmpty(value))
        {
            return false;
        }

        var s = value.Replace('-', '+').Replace('_', '/');
        switch (s.Length % 4)
        {
            case 2: s += "=="; break;
            case 3: s += "="; break;
            case 1: return false;
        }

        try
        {
            bytes = Convert.FromBase64String(s);
            return true;
        }
        catch (FormatException)
        {
            return false;
        }
    }
}
