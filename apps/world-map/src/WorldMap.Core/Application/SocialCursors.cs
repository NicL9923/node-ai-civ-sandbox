using WorldMap.Core.Common;

namespace WorldMap.Core.Application;

/// <summary>Stable social feed/endpoint identities a cursor is bound to.</summary>
public static class SocialFeedEndpoints
{
    public const string GlobalFeed = "global-feed";
    public const string AccountPosts = "account-posts";
    public const string FollowingFeed = "following-feed";
    public const string Thread = "thread";
    public const string Followers = "followers";
    public const string Following = "following";

    public const string DescDirection = "desc";
    public const string AscDirection = "asc";
}

/// <summary>Helpers for building and validating the opaque, self-bound social snapshot cursor.</summary>
public static class SocialCursors
{
    /// <summary>Sentinel keyset position for the first newest-first page (before any item ≤ hw).</summary>
    public const long DescStartWorldsequence = long.MaxValue;

    /// <summary>Sentinel keyset position for the first oldest-first page (before any item).</summary>
    public const long AscStartWorldsequence = -1;

    /// <summary>
    /// Resolves an incoming cursor for a request. Returns false (→ <c>cursor_filter_mismatch</c>) on a
    /// malformed cursor or one bound to a different endpoint/scope/filter/direction. A null/empty cursor
    /// yields (true, null) — a first-page request.
    /// </summary>
    public static bool TryResolve(string? cursor, SocialCursorBinding expected, out SocialCursorState? state)
    {
        if (!SocialCursorCodec.TryDecode(cursor, out state))
        {
            return false;
        }

        return state is null || state.Binding == expected;
    }

    public static string Encode(SocialCursorBinding binding, long highWatermark, long positionWorldsequence, string positionTieId, string? snapshotId = null) =>
        SocialCursorCodec.Encode(new SocialCursorState
        {
            Endpoint = binding.Endpoint,
            Scope = binding.Scope,
            Filter = binding.Filter,
            Direction = binding.Direction,
            HighWatermark = highWatermark,
            PositionWorldsequence = positionWorldsequence,
            PositionTieId = positionTieId,
            SnapshotId = snapshotId,
        });
}
