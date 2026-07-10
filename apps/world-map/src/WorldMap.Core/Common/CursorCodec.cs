using System.Text;
using System.Text.Json;

namespace WorldMap.Core.Common;

/// <summary>
/// Encodes/decodes the opaque, forward-only pagination cursor as
/// <c>base64url(utf8("{\"o\":&lt;ordinal&gt;}"))</c> without padding. Clients treat it as
/// opaque and echo it back in <c>after</c>. A missing/blank cursor decodes to ordinal 0
/// (start from the beginning).
/// </summary>
public static class CursorCodec
{
    public static string Encode(long ordinal)
    {
        var json = $"{{\"o\":{ordinal}}}";
        var bytes = Encoding.UTF8.GetBytes(json);
        return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    /// <summary>
    /// Decodes a cursor to its ordinal. Null/empty yields 0 (success). Malformed input
    /// yields false so the caller can return a 400.
    /// </summary>
    public static bool TryDecode(string? cursor, out long ordinal)
    {
        ordinal = 0;
        if (string.IsNullOrEmpty(cursor))
        {
            return true;
        }

        var s = cursor.Replace('-', '+').Replace('_', '/');
        switch (s.Length % 4)
        {
            case 2: s += "=="; break;
            case 3: s += "="; break;
            case 1: return false;
        }

        try
        {
            var json = Encoding.UTF8.GetString(Convert.FromBase64String(s));
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.TryGetProperty("o", out var o)
                && o.ValueKind == JsonValueKind.Number
                && o.TryGetInt64(out var value)
                && value >= 0)
            {
                ordinal = value;
                return true;
            }

            return false;
        }
        catch (Exception ex) when (ex is FormatException or JsonException)
        {
            return false;
        }
    }
}

/// <summary>Pagination bounds shared across list endpoints (contract: 1..200, default 50).</summary>
public static class Pagination
{
    public const int DefaultLimit = 50;
    public const int MaxLimit = 200;

    public static int ClampLimit(int? limit) =>
        limit is null ? DefaultLimit : Math.Clamp(limit.Value, 1, MaxLimit);
}
