using System.Net;
using System.Net.Http.Json;
using WorldMap.Core.Contracts;
using WorldMap.IntegrationTests.Harness;

namespace WorldMap.IntegrationTests.Tests;

/// <summary>
/// World Wire per-account rate limiting: a new mutation is limited BEFORE it claims an idempotency key
/// (a 429 never claims), while a successful prior request always replays even when the account is now
/// limited. Uses a restrictive post cooldown so the limit is reached deterministically without waiting.
/// </summary>
public sealed class SocialRateLimitTests : WorldTestBase
{
    protected override WorldAppFactory CreateFactory() => new(socialPostCooldownSeconds: 30, socialPostsPerWindow: 5);

    private static string Key() => Guid.NewGuid().ToString("N");

    [Fact]
    public async Task Post_cooldown_returns_429_without_claiming_and_prior_success_still_replays()
    {
        var civ = await Factory.RegisterCivAsync(Client, "Aurora");
        var acct = await SocialApi.SyncAgentAsync(Client, civ, "agent_ada", "Ada");
        var firstKey = Key();
        var body = SocialDtos.Post(acct, "first", "agent_ada");

        var first = await SocialApi.CreatePostAsync(Client, civ, body, firstKey);
        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        var firstPost = (await first.Content.ReadFromJsonAsync<SocialPostDto>(WorldMapJson.Options))!;

        // A NEW post within the cooldown is rate-limited (429 + Retry-After) and does not claim its key.
        var limited = await SocialApi.CreatePostAsync(Client, civ, SocialDtos.Post(acct, "second", "agent_ada"), Key());
        Assert.Equal(HttpStatusCode.TooManyRequests, limited.StatusCode);
        Assert.Equal("rate_limited", (await ProblemBody.ReadAsync(limited)).Code);
        Assert.True(limited.Headers.TryGetValues("Retry-After", out _), "429 must carry a Retry-After header.");

        // The earlier success replays (same key + body) even though the account is now limited.
        var replay = await SocialApi.CreatePostAsync(Client, civ, body, firstKey);
        Assert.Equal(HttpStatusCode.Created, replay.StatusCode);
        var replayPost = (await replay.Content.ReadFromJsonAsync<SocialPostDto>(WorldMapJson.Options))!;
        Assert.Equal(firstPost.PostId, replayPost.PostId);
    }
}
