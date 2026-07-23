using WorldMap.Core.Domain;

namespace WorldMap.Core.Abstractions;

/// <summary>A forward-only page for reconciliation enumeration (opaque continuation token).</summary>
public sealed record SocialListPage<T>(IReadOnlyList<T> Items, string? Continuation);

/// <summary>
/// Canonical World Wire account store. The World is the sole writer. Account identity is the deterministic
/// <see cref="SocialAccount.AccountId"/>, so an upsert is idempotent by id and natural-key/official
/// uniqueness is structural. <see cref="TryUpdateAsync"/> uses optimistic concurrency on <c>Version</c>
/// for eventually-consistent count projections.
/// </summary>
public interface ISocialAccountRepository
{
    Task<SocialAccount?> GetAsync(string accountId, CancellationToken ct);

    /// <summary>Create-or-replace by account id (canonical sync write).</summary>
    Task UpsertAsync(SocialAccount account, CancellationToken ct);

    /// <summary>Optimistic-concurrency update (count projections). Returns false if the version moved on.</summary>
    Task<bool> TryUpdateAsync(SocialAccount account, CancellationToken ct);

    /// <summary>Bounded forward-only enumeration for the count-reconciliation sweep.</summary>
    Task<SocialListPage<SocialAccount>> ListPageAsync(string? continuation, int limit, CancellationToken ct);
}

/// <summary>
/// Canonical World Wire post store. Posts are immutable except for the terminal tombstone transition and
/// eventually-consistent count projections. <see cref="AddAsync"/> is idempotent by the deterministic
/// post id; <see cref="TryUpdateAsync"/> is a compare-and-set on <c>Version</c>.
/// </summary>
public interface ISocialPostRepository
{
    /// <summary>Reads a post by id (cross-partition by-id lookup on Cosmos; posts partition by root).</summary>
    Task<SocialPost?> GetAsync(string postId, CancellationToken ct);

    /// <summary>Idempotent create: inserts if absent and returns the stored post (existing on a retry).</summary>
    Task<SocialPost> AddAsync(SocialPost post, CancellationToken ct);

    /// <summary>Optimistic-concurrency update. Returns false if the stored version moved on.</summary>
    Task<bool> TryUpdateAsync(SocialPost post, CancellationToken ct);

    /// <summary>Canonical count of posts authored by an account (for absolute reconciliation).</summary>
    Task<long> CountByAuthorAsync(string authorAccountId, CancellationToken ct);

    /// <summary>Canonical count of direct replies to a post (for absolute reconciliation).</summary>
    Task<long> CountRepliesAsync(string parentPostId, CancellationToken ct);

    /// <summary>Bounded forward-only enumeration for the count-reconciliation sweep.</summary>
    Task<SocialListPage<SocialPost>> ListPageAsync(string? continuation, int limit, CancellationToken ct);

    /// <summary>
    /// Thread snapshot page ordered <c>(worldsequence ASC, postId ASC)</c>, bounded by
    /// <paramref name="highWatermark"/>, strictly after <c>(afterWorldsequence, afterPostId)</c>.
    /// </summary>
    Task<IReadOnlyList<SocialPost>> ListThreadAsync(
        string conversationRootPostId, long highWatermark, long afterWorldsequence, string afterPostId, int limit, CancellationToken ct);

    /// <summary>Highest post worldsequence in a conversation (the thread-snapshot high-watermark).</summary>
    Task<long> MaxThreadWorldsequenceAsync(string conversationRootPostId, CancellationToken ct);

    /// <summary>Posts whose create process has not reached <see cref="SocialPostStep.Done"/> (worker repair).</summary>
    Task<IReadOnlyList<SocialPost>> ListIncompleteAsync(CancellationToken ct);
}

/// <summary>Canonical desired-state following edges. Single writer; CAS on <c>Version</c>.</summary>
public interface ISocialFollowRepository
{
    Task<SocialFollow?> GetAsync(string followerAccountId, string followedAccountId, CancellationToken ct);

    /// <summary>Optimistic-concurrency upsert. Returns false if the stored version moved on.</summary>
    Task<bool> TryUpsertAsync(SocialFollow follow, CancellationToken ct);

    /// <summary>All currently-following (following=true) edges for a follower (snapshot capture).</summary>
    Task<IReadOnlyList<SocialFollow>> ListActiveFollowedAsync(string followerAccountId, CancellationToken ct);

    /// <summary>Active followed edges newest-first by edge worldsequence (following list snapshot).</summary>
    Task<IReadOnlyList<SocialFollow>> ListFollowedDescendingAsync(
        string followerAccountId, long highWatermark, long afterWorldsequence, string afterTieId, int limit, CancellationToken ct);

    /// <summary>Active follower edges newest-first by edge worldsequence (followers list snapshot).</summary>
    Task<IReadOnlyList<SocialFollow>> ListFollowersDescendingAsync(
        string followedAccountId, long highWatermark, long afterWorldsequence, string afterTieId, int limit, CancellationToken ct);

    /// <summary>Highest edge worldsequence involving an account (for a list-snapshot high-watermark).</summary>
    Task<long> MaxFollowedWorldsequenceAsync(string followerAccountId, CancellationToken ct);

    Task<long> MaxFollowersWorldsequenceAsync(string followedAccountId, CancellationToken ct);

    /// <summary>Edges whose committed transition has not yet had its event appended (crash repair).</summary>
    Task<IReadOnlyList<SocialFollow>> ListPendingAsync(CancellationToken ct);

    /// <summary>Canonical count of active (following=true) edges FROM a follower (for reconciliation).</summary>
    Task<long> CountActiveFollowingAsync(string followerAccountId, CancellationToken ct);

    /// <summary>Canonical count of active (following=true) edges TO a followed account (for reconciliation).</summary>
    Task<long> CountActiveFollowersAsync(string followedAccountId, CancellationToken ct);
}

/// <summary>Canonical desired-state like edges. Single writer; CAS on <c>Version</c>.</summary>
public interface ISocialLikeRepository
{
    Task<SocialLike?> GetAsync(string postId, string accountId, CancellationToken ct);

    /// <summary>Optimistic-concurrency upsert. Returns false if the stored version moved on.</summary>
    Task<bool> TryUpsertAsync(SocialLike like, CancellationToken ct);

    /// <summary>Edges whose committed transition has not yet had its event appended (crash repair).</summary>
    Task<IReadOnlyList<SocialLike>> ListPendingAsync(CancellationToken ct);

    /// <summary>Canonical count of active (liked=true) edges on a post (for reconciliation).</summary>
    Task<long> CountActiveLikesAsync(string postId, CancellationToken ct);
}

/// <summary>
/// Immutable world-sequence feed index (global scope + per-author scope). <see cref="AddEntryAsync"/> is
/// idempotent by (scope, postId). Reads are bounded by a snapshot high-watermark so new posts never
/// appear mid-traversal.
/// </summary>
public interface ISocialFeedRepository
{
    Task AddEntryAsync(SocialFeedEntry entry, CancellationToken ct);

    /// <summary>Highest indexed worldsequence in a scope (the snapshot high-watermark).</summary>
    Task<long> MaxWorldsequenceAsync(string feedScope, CancellationToken ct);

    /// <summary>
    /// Newest-first page for a single scope, <c>worldsequence &lt;= highWatermark</c>, strictly after
    /// <c>(afterWorldsequence, afterPostId)</c> in <c>(worldsequence DESC, postId ASC)</c> order.
    /// </summary>
    Task<IReadOnlyList<SocialFeedEntry>> ListDescendingAsync(
        string feedScope, long highWatermark, long afterWorldsequence, string afterPostId, int limit, CancellationToken ct);

    /// <summary>Newest-first merged page across a frozen set of author scopes (following feed).</summary>
    Task<IReadOnlyList<SocialFeedEntry>> ListFollowingDescendingAsync(
        IReadOnlyCollection<string> authorScopes, long highWatermark, long afterWorldsequence, string afterPostId, int limit, CancellationToken ct);
}

/// <summary>Durable following-feed snapshots (TTL). Idempotent create by deterministic snapshot id.</summary>
public interface ISocialSnapshotStore
{
    Task<SocialSnapshot?> GetAsync(string snapshotId, CancellationToken ct);

    /// <summary>Create-if-absent (idempotent). Freezes the followed-set + high-watermark under a TTL.</summary>
    Task UpsertAsync(SocialSnapshot snapshot, CancellationToken ct);
}

/// <summary>Per-account rate-limit state (TTL). Single writer; simple upsert.</summary>
public interface ISocialRateLimitStore
{
    Task<SocialRateLimitState?> GetAsync(string accountId, CancellationToken ct);

    Task UpsertAsync(SocialRateLimitState state, DateTimeOffset expiresAt, CancellationToken ct);
}
