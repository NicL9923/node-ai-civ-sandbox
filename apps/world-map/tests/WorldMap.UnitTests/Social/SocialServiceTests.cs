using WorldMap.Core.Contracts;
using WorldMap.UnitTests.Services;
using Xunit;

namespace WorldMap.UnitTests.Social;

/// <summary>Service-layer social flows over the in-memory stores (no HTTP): sync → post → feed, follow.</summary>
public sealed class SocialServiceTests
{
    private const string Civ = "civ_ra";

    private static SocialMutationAuthorizationDto Auth(string localId) => new()
    {
        ActingLocalAgentId = localId,
        AuthorityDecision = new AuthorityDecisionDto { Mode = "agent", Ref = "intent_1" },
    };

    private static async Task<string> SyncAgentAsync(TestWorld w, string localId, string name)
    {
        var request = new SocialAccountSyncRequestDto
        {
            CivId = Civ,
            Accounts = [new SocialAccountUpsertDto { Actor = new SocialActorRefDto { CivId = Civ, LocalAgentId = localId, DisplayName = name, Kind = "agent" } }],
        };
        var result = await w.SocialAccountService.SyncAsync(Civ, request, Guid.NewGuid().ToString("N"), CancellationToken.None);
        Assert.True(result.IsSuccess);
        return result.Value.Body.Accounts[0].AccountId;
    }

    [Fact]
    public async Task Sync_then_post_appears_in_global_feed()
    {
        var w = new TestWorld();
        var acct = await SyncAgentAsync(w, "agent_ada", "Ada");

        var post = await w.SocialPostService.CreateAsync(
            Civ,
            new SocialPostCreateRequestDto { AuthorAccountId = acct, Text = "hello", Authorization = Auth("agent_ada") },
            Guid.NewGuid().ToString("N"),
            CancellationToken.None);
        Assert.True(post.IsSuccess);

        var feed = await w.SocialFeedService.GlobalAsync(null, null, CancellationToken.None);
        Assert.True(feed.IsSuccess);
        Assert.Contains(feed.Value.Items, p => p.PostId == post.Value.Body.PostId);
    }

    [Fact]
    public async Task Follow_updates_projected_counts()
    {
        var w = new TestWorld();
        var a = await SyncAgentAsync(w, "agent_a", "A");
        var b = await SyncAgentAsync(w, "agent_b", "B");

        var follow = await w.SocialGraphService.SetFollowAsync(
            Civ, a, b,
            new SocialFollowSetRequestDto { Following = true, Authorization = Auth("agent_a") },
            Guid.NewGuid().ToString("N"),
            CancellationToken.None);
        Assert.True(follow.IsSuccess);
        Assert.True(follow.Value.Body.Changed);

        var target = await w.SocialAccountService.GetAsync(b, CancellationToken.None);
        Assert.True(target.IsSuccess);
        Assert.Equal(1, target.Value.FollowerCount);
    }
}
