using WorldMap.Core.Common;

namespace WorldMap.Core.Domain;

/// <summary>
/// Deterministic identifier helpers for World Wire social resources. Ids that name durable/repairable
/// artifacts are derived from stable keys so a retry/replay reuses the exact same identity:
/// an account id is stable across display changes and elections; a post id is stable across retries;
/// event dedupe keys guarantee exactly one public event per logical mutation.
/// </summary>
public static class SocialIds
{
    /// <summary>
    /// Stable opaque account id derived from the natural key (civId, kind, localAgentId). Official
    /// accounts have no localAgentId, so exactly one official id exists per civ; an agent id is unique
    /// per (civId, localAgentId). A display-name change never changes this id.
    /// </summary>
    public static string AccountId(string civId, string kind, string? localAgentId) =>
        Deterministic.Id("acct_", "social-account", civId, kind, localAgentId ?? string.Empty);

    /// <summary>Deterministic post id derived from the mutation's idempotency scope (stable across retries).</summary>
    public static string PostId(string idempotencyScope) =>
        Deterministic.Id("post_", "social-post", idempotencyScope);

    /// <summary>Cosmos-safe deterministic doc id for a follow edge (follower → followed).</summary>
    public static string FollowDocId(string followerAccountId, string followedAccountId) =>
        Deterministic.Id("flw_", "social-follow", followerAccountId, followedAccountId);

    /// <summary>Cosmos-safe deterministic doc id for a like edge (account → post).</summary>
    public static string LikeDocId(string postId, string accountId) =>
        Deterministic.Id("lik_", "social-like", postId, accountId);

    /// <summary>Deterministic following-feed snapshot id (owner + captured high-watermark).</summary>
    public static string SnapshotId(string ownerAccountId, long highWatermark) =>
        Deterministic.Id("snap_", "social-snapshot", SocialSnapshot.FollowingFeedKind, ownerAccountId, highWatermark.ToString());

    /// <summary>Producer-scoped dedupe key for a social world event (one per logical mutation).</summary>
    public static string EventDedupe(string kind, string seed) => $"social:{kind}:{Deterministic.ShortHash(seed)}";

    /// <summary>Deterministic CloudEvent id for a social world event (stable across retries).</summary>
    public static string EventId(string dedupeKey) => Deterministic.Id("evt_", "social-event", dedupeKey);
}
