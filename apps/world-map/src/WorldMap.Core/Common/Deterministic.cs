using System.Security.Cryptography;
using System.Text;

namespace WorldMap.Core.Common;

/// <summary>
/// Deterministic helpers for stable, non-random identifiers and canonical request fingerprints.
/// Repair/replay artifacts (interaction ids, command ids, event ids, idempotency scopes) MUST be
/// derived deterministically so a resumed operation reuses the exact same identity — never
/// <c>Guid.NewGuid()</c>.
/// </summary>
public static class Deterministic
{
    /// <summary>Lowercase-hex SHA-256 of a UTF-8 string.</summary>
    public static string Sha256Hex(string value)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    /// <summary>A short (128-bit) lowercase-hex digest, suitable for compact deterministic ids.</summary>
    public static string ShortHash(string value) => Sha256Hex(value)[..32];

    /// <summary>Builds a prefixed deterministic id from one or more stable parts.</summary>
    public static string Id(string prefix, params string[] parts)
        => $"{prefix}{ShortHash(string.Join('\u001f', parts))}";
}
