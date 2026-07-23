using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Options;
using WorldMap.Core.Configuration;
using WorldMap.Core.Contracts;

namespace WorldMap.Core.Application;

/// <summary>
/// Builds citizen-safe, bounded public payloads for World Wire social world events. Payloads are the
/// typed public event-data DTOs (which contain ONLY public account/post identifiers and bounded public
/// projections — never mutation authorization, President decisions, HMAC data, private profiles, or
/// deleted text). Every payload is size-capped at <see cref="EventOptions.MaxPublicDataBytes"/>; an
/// over-limit payload yields null (the event still appends, carrying no public data).
/// </summary>
public sealed class SocialEventFactory(IOptions<WorldMapOptions> options)
{
    private readonly int _maxBytes = options.Value.Events.MaxPublicDataBytes;

    public JsonNode? AccountSynced(SocialAccountSyncedEventDataDto data) => Bound(data);

    public JsonNode? PostCreated(SocialPostDto post) => Bound(new SocialPostEventDataDto { Post = post });

    public JsonNode? ReplyCreated(SocialPostDto post) => Bound(new SocialPostEventDataDto { Post = post });

    public JsonNode? ReactionChanged(SocialPostReactionChangedEventDataDto data) => Bound(data);

    public JsonNode? FollowChanged(SocialFollowChangedEventDataDto data) => Bound(data);

    public JsonNode? Tombstoned(SocialPostTombstonedEventDataDto data) => Bound(data);

    private JsonNode? Bound<T>(T data)
    {
        var node = JsonSerializer.SerializeToNode(data, WorldMapJson.Options);
        if (node is null)
        {
            return null;
        }

        var bytes = Encoding.UTF8.GetByteCount(node.ToJsonString(WorldMapJson.Options));
        return bytes <= _maxBytes ? node : null;
    }
}

/// <summary>Citizen-safe social CloudEvent types (all World-originated; the terminal post lifecycle is closed).</summary>
public static class SocialEventTypes
{
    public const string Source = "/world/v1/social";

    public const string AccountSynced = "world.social.account.synced.v1";
    public const string PostCreated = "world.social.post.created.v1";
    public const string ReplyCreated = "world.social.reply.created.v1";
    public const string PostLiked = "world.social.post.liked.v1";
    public const string PostUnliked = "world.social.post.unliked.v1";
    public const string AccountFollowed = "world.social.account.followed.v1";
    public const string AccountUnfollowed = "world.social.account.unfollowed.v1";
    public const string PostTombstoned = "world.social.post.tombstoned.v1";
}
