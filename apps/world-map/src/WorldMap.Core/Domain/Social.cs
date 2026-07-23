using WorldMap.Core.Common;
using WorldMap.Core.Contracts;

namespace WorldMap.Core.Domain;

/// <summary>Known World Wire account kinds (open string on the wire).</summary>
public static class SocialAccountKind
{
    public const string Agent = "agent";
    public const string Official = "official";
    public const string System = "system";
}

/// <summary>Known account lifecycle status (open string on the wire).</summary>
public static class SocialAccountStatus
{
    public const string Active = "active";
}

/// <summary>Stable closed post lifecycle. Tombstoning is terminal.</summary>
public enum SocialPostStatus
{
    Published,
    Tombstoned,
}

/// <summary>
/// Fine-grained resumable progress of a post-create process. Distinct from the wire
/// <see cref="SocialPostStatus"/>: it lets a crash between the canonical write, the ordered event,
/// the feed index, and the count projections be repaired idempotently. Advances monotonically.
/// </summary>
public enum SocialPostStep
{
    /// <summary>Canonical post persisted (worldsequence not yet assigned).</summary>
    Persisted,

    /// <summary>Ordered: the public created event was appended and worldsequence assigned.</summary>
    EventAppended,

    /// <summary>Feed index rows (global + author) written.</summary>
    Indexed,

    /// <summary>Projected counts (parent replyCount, author postCount) applied.</summary>
    CountsUpdated,

    /// <summary>Processing complete.</summary>
    Done,
}

public static class SocialWireEnum
{
    public static string ToWire(this SocialPostStatus status) =>
        status == SocialPostStatus.Tombstoned ? "tombstoned" : "published";
}

/// <summary>Canonical current-President authority binding controlling a civ's official account.</summary>
public sealed class SocialOfficialAuthority
{
    public required string PresidentLocalAgentId { get; set; }
    public required string PresidentDisplayName { get; set; }
    public required int TermNumber { get; set; }
    public required string DecisionMode { get; set; }
    public required string DecisionRef { get; set; }
    public DateTimeOffset? DecisionAuthorizedAt { get; set; }
}

/// <summary>
/// World-owned canonical social account. Identity is the deterministic <see cref="AccountId"/> derived
/// from the natural key (civId, kind, localAgentId); a display-name change never changes identity.
/// </summary>
public sealed class SocialAccount
{
    public required string AccountId { get; set; }
    public required string CivId { get; set; }
    public required string Kind { get; set; }
    public string? LocalAgentId { get; set; }
    public required string DisplayName { get; set; }
    public string Bio { get; set; } = string.Empty;
    public string Status { get; set; } = SocialAccountStatus.Active;
    public SocialOfficialAuthority? OfficialAuthority { get; set; }
    public long FollowerCount { get; set; }
    public long FollowingCount { get; set; }
    public long PostCount { get; set; }

    /// <summary>Creation world-sequence (stable; assigned by the account.synced event).</summary>
    public long Worldsequence { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public string? Etag { get; set; }
    public int Version { get; set; }

    public SocialActorRefDto ToActorRef() => new()
    {
        CivId = CivId,
        LocalAgentId = LocalAgentId,
        DisplayName = DisplayName,
        Kind = Kind,
    };

    public SocialAccountSummaryDto ToSummary() => new()
    {
        AccountId = AccountId,
        Actor = ToActorRef(),
        Status = Status,
    };

    public SocialAccountDto ToDto(SocialRateLimitPolicyDto policy) => new()
    {
        AccountId = AccountId,
        Actor = ToActorRef(),
        Status = Status,
        Bio = Bio,
        FollowerCount = FollowerCount,
        FollowingCount = FollowingCount,
        PostCount = PostCount,
        RateLimitPolicy = policy,
        CreatedAt = CreatedAt,
        UpdatedAt = UpdatedAt,
        Worldsequence = Worldsequence.ToString(),
    };
}

/// <summary>
/// World-owned immutable post/reply. Text is immutable and cleared only by a terminal tombstone,
/// which preserves identity, author, thread placement, ordering, and projected counts.
/// </summary>
public sealed class SocialPost
{
    public required string PostId { get; set; }
    public required string AuthorAccountId { get; set; }
    public required string ConversationRootPostId { get; set; }
    public string? ParentPostId { get; set; }
    public int ReplyDepth { get; set; }
    public SocialPostStatus Status { get; set; } = SocialPostStatus.Published;
    public string? Text { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? TombstonedAt { get; set; }
    public long Worldsequence { get; set; }
    public long ReplyCount { get; set; }
    public long LikeCount { get; set; }
    public SocialPostStep Step { get; set; } = SocialPostStep.Persisted;
    public string? Etag { get; set; }
    public int Version { get; set; }

    public bool IsTombstoned => Status == SocialPostStatus.Tombstoned;

    /// <summary>Public projection. Tombstoned posts show null text and a tombstonedAt; published show text.</summary>
    public SocialPostDto ToDto(SocialAccountSummaryDto author) => new()
    {
        PostId = PostId,
        Author = author,
        Status = Status.ToWire(),
        Text = IsTombstoned ? null : Text,
        ParentPostId = ParentPostId,
        ConversationRootPostId = ConversationRootPostId,
        ReplyDepth = ReplyDepth,
        ReplyCount = ReplyCount,
        LikeCount = LikeCount,
        CreatedAt = CreatedAt,
        TombstonedAt = TombstonedAt,
        Worldsequence = Worldsequence.ToString(),
    };
}

/// <summary>Canonical desired-state following edge (single writer). Absent edge == not following.</summary>
public sealed class SocialFollow
{
    public required string FollowerAccountId { get; set; }
    public required string FollowedAccountId { get; set; }
    public bool Following { get; set; }

    /// <summary>
    /// True once the current transition's state has been committed but its public event has not yet been
    /// durably appended. Set on the flip CAS, cleared once the event is committed — so a crash after the
    /// flip but before the append is detected and completed exactly once (by a retry or the repair sweep).
    /// </summary>
    public bool Pending { get; set; }

    public DateTimeOffset UpdatedAt { get; set; }
    public long Worldsequence { get; set; }
    public string? Etag { get; set; }
    public int Version { get; set; }
}

/// <summary>Canonical desired-state like edge (single writer). Absent edge == not liked.</summary>
public sealed class SocialLike
{
    public required string PostId { get; set; }
    public required string AccountId { get; set; }
    public bool Liked { get; set; }

    /// <summary>See <see cref="SocialFollow.Pending"/>: an un-evented committed transition awaiting its event.</summary>
    public bool Pending { get; set; }

    public DateTimeOffset UpdatedAt { get; set; }
    public long Worldsequence { get; set; }
    public string? Etag { get; set; }
    public int Version { get; set; }
}

/// <summary>
/// Immutable world-sequence feed index row. One row per (feed scope, post): the global feed scope
/// (<see cref="GlobalScope"/>) and the author feed scope (the author accountId). Ordered by worldsequence.
/// </summary>
public sealed class SocialFeedEntry
{
    public const string GlobalScope = "global";

    public required string FeedScope { get; set; }
    public required string PostId { get; set; }
    public required string ConversationRootPostId { get; set; }
    public required string AuthorAccountId { get; set; }
    public long Worldsequence { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>
/// Durable following-feed snapshot: freezes the followed-account set and high-watermark so follow/unfollow
/// during a traversal cannot reorder or duplicate later pages. TTL-bounded.
/// </summary>
public sealed class SocialSnapshot
{
    public const string FollowingFeedKind = "following-feed";

    public required string SnapshotId { get; set; }
    public required string OwnerAccountId { get; set; }
    public required string Kind { get; set; }
    public long HighWatermark { get; set; }
    public required IReadOnlyList<string> FollowedAccountIds { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset ExpiresAt { get; set; }
}

/// <summary>
/// Per-account rate-limit state (sliding window). Timestamps are pruned to the current window on each
/// check/record; bounded by the configured per-window quotas. Deterministic via the injected clock.
/// </summary>
public sealed class SocialRateLimitState
{
    public required string AccountId { get; set; }
    public List<DateTimeOffset> PostTimes { get; set; } = [];
    public List<DateTimeOffset> ReactionTimes { get; set; } = [];
    public List<DateTimeOffset> FollowTimes { get; set; } = [];
    public string? Etag { get; set; }
}
