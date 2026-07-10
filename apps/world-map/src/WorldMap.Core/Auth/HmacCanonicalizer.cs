using System.Security.Cryptography;
using System.Text;

namespace WorldMap.Core.Auth;

/// <summary>
/// The signed inputs that make up the HMAC canonical string. <see cref="IdempotencyKey"/>
/// is the empty string for non-idempotent reads.
/// </summary>
public sealed record HmacSignedRequest(
    string ProtocolVersion,
    string CivId,
    string KeyId,
    string Timestamp,
    string Nonce,
    string IdempotencyKey,
    string Method,
    string Path,
    string RawQuery,
    ReadOnlyMemory<byte> Body);

/// <summary>
/// Builds the federation HMAC canonical string (10 fields joined by a single LF, no
/// trailing newline) and the lowercase-hex SHA-256 of the raw request body. Pure so
/// the golden vectors can assert every intermediate value.
/// </summary>
public static class HmacCanonicalizer
{
    public const string ProtocolVersion = "1";
    public const int ReplayWindowSeconds = 300;

    /// <summary>Lowercase-hex SHA-256 of the raw body bytes (empty body =&gt; hash of zero bytes).</summary>
    public static string BodySha256Hex(ReadOnlySpan<byte> body)
    {
        Span<byte> hash = stackalloc byte[32];
        SHA256.HashData(body, hash);
        return Convert.ToHexStringLower(hash);
    }

    /// <summary>Builds the canonical string from an already-canonicalized query and body hash.</summary>
    public static string BuildCanonicalString(
        string protocolVersion,
        string civId,
        string keyId,
        string timestamp,
        string nonce,
        string idempotencyKey,
        string method,
        string path,
        string canonicalQuery,
        string bodySha256Hex)
    {
        var sb = new StringBuilder(256);
        sb.Append(protocolVersion).Append('\n')
          .Append(civId).Append('\n')
          .Append(keyId).Append('\n')
          .Append(timestamp).Append('\n')
          .Append(nonce).Append('\n')
          .Append(idempotencyKey).Append('\n')
          .Append(method.ToUpperInvariant()).Append('\n')
          .Append(path).Append('\n')
          .Append(canonicalQuery).Append('\n')
          .Append(bodySha256Hex);
        return sb.ToString();
    }

    /// <summary>Builds the canonical string for a full request, canonicalizing the query and hashing the body.</summary>
    public static string BuildCanonicalString(HmacSignedRequest request) =>
        BuildCanonicalString(
            request.ProtocolVersion,
            request.CivId,
            request.KeyId,
            request.Timestamp,
            request.Nonce,
            request.IdempotencyKey,
            request.Method,
            request.Path,
            QueryCanonicalizer.Canonicalize(request.RawQuery),
            BodySha256Hex(request.Body.Span));
}
