using System.Text.Json.Serialization;

namespace WorldMap.Core.Contracts;

// World Wire social wire DTOs mirroring packages/federation-contracts/schemas/social/*.yaml exactly.
// These are the authoritative System.Text.Json shapes for the social runtime and are conformance-tested
// against the generated contract artifacts and example fixtures. worldsequence is a decimal STRING (never
// a number). Nullable/optional fields are omitted on write (WhenWritingNull); the conformance harness
// treats an original null as satisfied by an omitted property, matching the existing DTO convention.
// AuthorityDecisionDto (mode/ref/authorizedAt) is reused from InteractionContracts.cs.

#region Identity

/// <summary>Stable, citizen-safe civ-scoped actor identity. Never carries private/profile/credential data.</summary>
public sealed record SocialActorRefDto
{
    [JsonPropertyName("civId")]
    public required string CivId { get; init; }

    [JsonPropertyName("localAgentId")]
    public string? LocalAgentId { get; init; }

    [JsonPropertyName("displayName")]
    public required string DisplayName { get; init; }

    [JsonPropertyName("kind")]
    public required string Kind { get; init; }
}

/// <summary>Compact citizen-safe account projection embedded in posts and events.</summary>
public sealed record SocialAccountSummaryDto
{
    [JsonPropertyName("accountId")]
    public required string AccountId { get; init; }

    [JsonPropertyName("actor")]
    public required SocialActorRefDto Actor { get; init; }

    [JsonPropertyName("status")]
    public required string Status { get; init; }
}

/// <summary>Server-advertised per-account anti-spam policy (deployment policy values).</summary>
public sealed record SocialRateLimitPolicyDto
{
    [JsonPropertyName("postCooldownSeconds")]
    public required int PostCooldownSeconds { get; init; }

    [JsonPropertyName("postsPerWindow")]
    public required int PostsPerWindow { get; init; }

    [JsonPropertyName("reactionsPerWindow")]
    public required int ReactionsPerWindow { get; init; }

    [JsonPropertyName("followsPerWindow")]
    public required int FollowsPerWindow { get; init; }

    [JsonPropertyName("windowSeconds")]
    public required int WindowSeconds { get; init; }
}

/// <summary>World-owned public social account projection.</summary>
public sealed record SocialAccountDto
{
    [JsonPropertyName("accountId")]
    public required string AccountId { get; init; }

    [JsonPropertyName("actor")]
    public required SocialActorRefDto Actor { get; init; }

    [JsonPropertyName("status")]
    public required string Status { get; init; }

    [JsonPropertyName("bio")]
    public required string Bio { get; init; }

    [JsonPropertyName("followerCount")]
    public required long FollowerCount { get; init; }

    [JsonPropertyName("followingCount")]
    public required long FollowingCount { get; init; }

    [JsonPropertyName("postCount")]
    public required long PostCount { get; init; }

    [JsonPropertyName("rateLimitPolicy")]
    public required SocialRateLimitPolicyDto RateLimitPolicy { get; init; }

    [JsonPropertyName("createdAt")]
    public required DateTimeOffset CreatedAt { get; init; }

    [JsonPropertyName("updatedAt")]
    public required DateTimeOffset UpdatedAt { get; init; }

    [JsonPropertyName("worldsequence")]
    public required string Worldsequence { get; init; }
}

#endregion

#region Authorization

/// <summary>Current President authority controlling a civ's single official account.</summary>
public sealed record SocialOfficialAuthorityDto
{
    [JsonPropertyName("presidentLocalAgentId")]
    public required string PresidentLocalAgentId { get; init; }

    [JsonPropertyName("presidentDisplayName")]
    public required string PresidentDisplayName { get; init; }

    [JsonPropertyName("termNumber")]
    public required int TermNumber { get; init; }

    [JsonPropertyName("authorityDecision")]
    public required AuthorityDecisionDto AuthorityDecision { get; init; }
}

/// <summary>Civ-local actor and decision metadata for a social mutation (private audit; never public).</summary>
public sealed record SocialMutationAuthorizationDto
{
    [JsonPropertyName("actingLocalAgentId")]
    public required string ActingLocalAgentId { get; init; }

    [JsonPropertyName("authorityDecision")]
    public required AuthorityDecisionDto AuthorityDecision { get; init; }

    [JsonPropertyName("officialTermNumber")]
    public int? OfficialTermNumber { get; init; }
}

#endregion

#region Account sync

/// <summary>One account in an atomic bounded sync batch.</summary>
public sealed record SocialAccountUpsertDto
{
    [JsonPropertyName("actor")]
    public required SocialActorRefDto Actor { get; init; }

    [JsonPropertyName("bio")]
    public string? Bio { get; init; }

    [JsonPropertyName("officialAuthority")]
    public SocialOfficialAuthorityDto? OfficialAuthority { get; init; }
}

/// <summary>Atomic idempotent upsert of 1-100 accounts owned by one authenticated civ.</summary>
public sealed record SocialAccountSyncRequestDto
{
    [JsonPropertyName("civId")]
    public required string CivId { get; init; }

    [JsonPropertyName("accounts")]
    public required IReadOnlyList<SocialAccountUpsertDto> Accounts { get; init; }
}

/// <summary>Accounts after an atomic sync, in request order.</summary>
public sealed record SocialAccountSyncResponseDto
{
    [JsonPropertyName("accounts")]
    public required IReadOnlyList<SocialAccountDto> Accounts { get; init; }
}

#endregion

#region Posts

/// <summary>Immutable World-owned post/reply projection. Tombstones clear text but keep identity/order.</summary>
public sealed record SocialPostDto
{
    [JsonPropertyName("postId")]
    public required string PostId { get; init; }

    [JsonPropertyName("author")]
    public required SocialAccountSummaryDto Author { get; init; }

    [JsonPropertyName("status")]
    public required string Status { get; init; }

    [JsonPropertyName("text")]
    public string? Text { get; init; }

    [JsonPropertyName("parentPostId")]
    public string? ParentPostId { get; init; }

    [JsonPropertyName("conversationRootPostId")]
    public required string ConversationRootPostId { get; init; }

    [JsonPropertyName("replyDepth")]
    public required int ReplyDepth { get; init; }

    [JsonPropertyName("replyCount")]
    public required long ReplyCount { get; init; }

    [JsonPropertyName("likeCount")]
    public required long LikeCount { get; init; }

    [JsonPropertyName("createdAt")]
    public required DateTimeOffset CreatedAt { get; init; }

    [JsonPropertyName("tombstonedAt")]
    public DateTimeOffset? TombstonedAt { get; init; }

    [JsonPropertyName("worldsequence")]
    public required string Worldsequence { get; init; }
}

/// <summary>Create an immutable root post or bounded reply.</summary>
public sealed record SocialPostCreateRequestDto
{
    [JsonPropertyName("authorAccountId")]
    public required string AuthorAccountId { get; init; }

    [JsonPropertyName("text")]
    public required string Text { get; init; }

    [JsonPropertyName("parentPostId")]
    public string? ParentPostId { get; init; }

    [JsonPropertyName("authorization")]
    public required SocialMutationAuthorizationDto Authorization { get; init; }
}

/// <summary>Author-authorized terminal tombstone request.</summary>
public sealed record SocialPostTombstoneRequestDto
{
    [JsonPropertyName("authorization")]
    public required SocialMutationAuthorizationDto Authorization { get; init; }
}

#endregion

#region Follows and likes

/// <summary>Idempotently set a following relation; never toggle.</summary>
public sealed record SocialFollowSetRequestDto
{
    [JsonPropertyName("following")]
    public required bool Following { get; init; }

    [JsonPropertyName("authorization")]
    public required SocialMutationAuthorizationDto Authorization { get; init; }
}

/// <summary>Canonical World-owned desired-state result for a following relation.</summary>
public sealed record SocialFollowDto
{
    [JsonPropertyName("followerAccountId")]
    public required string FollowerAccountId { get; init; }

    [JsonPropertyName("followedAccountId")]
    public required string FollowedAccountId { get; init; }

    [JsonPropertyName("following")]
    public required bool Following { get; init; }

    [JsonPropertyName("changed")]
    public required bool Changed { get; init; }

    [JsonPropertyName("updatedAt")]
    public required DateTimeOffset UpdatedAt { get; init; }

    [JsonPropertyName("worldsequence")]
    public required string Worldsequence { get; init; }
}

/// <summary>Idempotently set the actor account's like state; never toggle.</summary>
public sealed record SocialReactionSetRequestDto
{
    [JsonPropertyName("liked")]
    public required bool Liked { get; init; }

    [JsonPropertyName("authorization")]
    public required SocialMutationAuthorizationDto Authorization { get; init; }
}

/// <summary>Canonical World-owned desired-state result for a post like.</summary>
public sealed record SocialReactionDto
{
    [JsonPropertyName("postId")]
    public required string PostId { get; init; }

    [JsonPropertyName("accountId")]
    public required string AccountId { get; init; }

    [JsonPropertyName("liked")]
    public required bool Liked { get; init; }

    [JsonPropertyName("changed")]
    public required bool Changed { get; init; }

    [JsonPropertyName("likeCount")]
    public required long LikeCount { get; init; }

    [JsonPropertyName("updatedAt")]
    public required DateTimeOffset UpdatedAt { get; init; }

    [JsonPropertyName("worldsequence")]
    public required string Worldsequence { get; init; }
}

#endregion

#region Pages

/// <summary>Snapshot cursor page of public social accounts.</summary>
public sealed record SocialAccountPageDto
{
    [JsonPropertyName("items")]
    public required IReadOnlyList<SocialAccountSummaryDto> Items { get; init; }

    [JsonPropertyName("nextCursor")]
    public string? NextCursor { get; init; }
}

/// <summary>Immutable snapshot page of posts ordered by (worldsequence DESC, postId ASC).</summary>
public sealed record SocialPostPageDto
{
    [JsonPropertyName("items")]
    public required IReadOnlyList<SocialPostDto> Items { get; init; }

    [JsonPropertyName("nextCursor")]
    public string? NextCursor { get; init; }
}

/// <summary>Conversation snapshot ordered by (worldsequence ASC, postId ASC).</summary>
public sealed record SocialThreadPageDto
{
    [JsonPropertyName("conversationRootPostId")]
    public required string ConversationRootPostId { get; init; }

    [JsonPropertyName("items")]
    public required IReadOnlyList<SocialPostDto> Items { get; init; }

    [JsonPropertyName("nextCursor")]
    public string? NextCursor { get; init; }
}

#endregion

#region Event data (citizen-safe public payloads)

/// <summary>Bounded summary payload for <c>world.social.account.synced.v1</c>.</summary>
public sealed record SocialAccountSyncedEventDataDto
{
    [JsonPropertyName("civId")]
    public required string CivId { get; init; }

    [JsonPropertyName("accountIds")]
    public required IReadOnlyList<string> AccountIds { get; init; }

    [JsonPropertyName("createdCount")]
    public required int CreatedCount { get; init; }

    [JsonPropertyName("updatedCount")]
    public required int UpdatedCount { get; init; }
}

/// <summary>Payload for <c>world.social.post.created.v1</c> / <c>world.social.reply.created.v1</c>.</summary>
public sealed record SocialPostEventDataDto
{
    [JsonPropertyName("post")]
    public required SocialPostDto Post { get; init; }
}

/// <summary>Payload for <c>world.social.post.liked.v1</c> / <c>world.social.post.unliked.v1</c>.</summary>
public sealed record SocialPostReactionChangedEventDataDto
{
    [JsonPropertyName("postId")]
    public required string PostId { get; init; }

    [JsonPropertyName("accountId")]
    public required string AccountId { get; init; }

    [JsonPropertyName("liked")]
    public required bool Liked { get; init; }

    [JsonPropertyName("changedAt")]
    public required DateTimeOffset ChangedAt { get; init; }
}

/// <summary>Payload for <c>world.social.account.followed.v1</c> / <c>...unfollowed.v1</c>.</summary>
public sealed record SocialFollowChangedEventDataDto
{
    [JsonPropertyName("followerAccountId")]
    public required string FollowerAccountId { get; init; }

    [JsonPropertyName("followedAccountId")]
    public required string FollowedAccountId { get; init; }

    [JsonPropertyName("following")]
    public required bool Following { get; init; }

    [JsonPropertyName("changedAt")]
    public required DateTimeOffset ChangedAt { get; init; }
}

/// <summary>Payload for <c>world.social.post.tombstoned.v1</c> (never repeats the deleted text).</summary>
public sealed record SocialPostTombstonedEventDataDto
{
    [JsonPropertyName("postId")]
    public required string PostId { get; init; }

    [JsonPropertyName("authorAccountId")]
    public required string AuthorAccountId { get; init; }

    [JsonPropertyName("conversationRootPostId")]
    public required string ConversationRootPostId { get; init; }

    [JsonPropertyName("tombstonedAt")]
    public required DateTimeOffset TombstonedAt { get; init; }
}

#endregion
