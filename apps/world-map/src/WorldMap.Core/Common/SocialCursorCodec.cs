using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace WorldMap.Core.Common;

/// <summary>
/// Direction and identity a social snapshot cursor is bound to. A cursor may only be replayed against a
/// request whose endpoint/scope/filter/direction match; any mismatch is a <c>cursor_filter_mismatch</c>.
/// </summary>
/// <param name="Endpoint">Stable feed identity (e.g. <c>global-feed</c>, <c>account-posts</c>, <c>thread</c>).</param>
/// <param name="Scope">Account/thread id the feed is scoped to (empty for the global feed).</param>
/// <param name="Filter">Reserved filter discriminator (empty in v1).</param>
/// <param name="Direction"><c>desc</c> (newest-first) or <c>asc</c> (thread, oldest-first).</param>
public readonly record struct SocialCursorBinding(string Endpoint, string Scope, string Filter, string Direction);

/// <summary>
/// Fully-decoded social cursor: the binding it was issued for, the snapshot high-watermark (so new posts
/// never appear mid-traversal), a durable snapshot id (following feed only), and the keyset position
/// (last returned <c>(worldsequence, tieId)</c>). Position is exclusive: the next page starts strictly after it.
/// </summary>
public sealed record SocialCursorState
{
    [JsonPropertyName("v")]
    public int Version { get; init; } = 1;

    [JsonPropertyName("ep")]
    public required string Endpoint { get; init; }

    [JsonPropertyName("sc")]
    public string Scope { get; init; } = string.Empty;

    [JsonPropertyName("fl")]
    public string Filter { get; init; } = string.Empty;

    [JsonPropertyName("dr")]
    public required string Direction { get; init; }

    [JsonPropertyName("hw")]
    public long HighWatermark { get; init; }

    [JsonPropertyName("ws")]
    public long PositionWorldsequence { get; init; }

    [JsonPropertyName("ti")]
    public string PositionTieId { get; init; } = string.Empty;

    [JsonPropertyName("sn")]
    public string? SnapshotId { get; init; }

    public SocialCursorBinding Binding => new(Endpoint, Scope, Filter, Direction);
}

/// <summary>
/// Encodes/decodes the opaque, forward-only, self-bound social pagination cursor as
/// <c>base64url(utf8(json))</c> without padding. The binding fields (endpoint/scope/filter/direction),
/// the snapshot high-watermark, and the keyset position all travel inside the token — no client-parseable
/// ids or timestamps, and no signing secret (public reads; tampering yields a mismatch or a valid
/// different traversal). Bounded well under the 4096-character contract limit.
/// </summary>
public static class SocialCursorCodec
{
    private const int MaxCursorChars = 4096;

    private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static string Encode(SocialCursorState state)
    {
        var json = JsonSerializer.Serialize(state, Options);
        var bytes = Encoding.UTF8.GetBytes(json);
        return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    /// <summary>
    /// Decodes a cursor. Null/empty yields (true, null) — a first-page request. Malformed input yields
    /// (false, null) so the caller returns <c>cursor_filter_mismatch</c>. A valid cursor yields (true, state).
    /// </summary>
    public static bool TryDecode(string? cursor, out SocialCursorState? state)
    {
        state = null;
        if (string.IsNullOrEmpty(cursor))
        {
            return true;
        }

        if (cursor.Length > MaxCursorChars)
        {
            return false;
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
            var decoded = JsonSerializer.Deserialize<SocialCursorState>(json, Options);
            if (decoded is null || decoded.Version != 1 || string.IsNullOrEmpty(decoded.Endpoint) ||
                string.IsNullOrEmpty(decoded.Direction) || decoded.HighWatermark < 0)
            {
                return false;
            }

            state = decoded;
            return true;
        }
        catch (Exception ex) when (ex is FormatException or JsonException or DecoderFallbackException)
        {
            return false;
        }
    }
}
