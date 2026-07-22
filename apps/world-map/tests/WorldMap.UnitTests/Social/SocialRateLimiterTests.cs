using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;
using WorldMap.Core.Application;
using WorldMap.Core.Configuration;
using WorldMap.Infrastructure.InMemory;
using Xunit;

namespace WorldMap.UnitTests.Social;

/// <summary>Deterministic per-account social rate limiter (store-backed sliding window).</summary>
public sealed class SocialRateLimiterTests
{
    private static SocialRateLimiter Build(FakeTimeProvider clock, SocialRateLimitOptions cfg)
    {
        var store = new InMemorySocialRateLimitStore();
        var options = Options.Create(new WorldMapOptions { Social = new SocialOptions { RateLimit = cfg } });
        return new SocialRateLimiter(store, clock, options);
    }

    private static FakeTimeProvider Clock() => new(new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero));

    [Fact]
    public async Task Post_cooldown_blocks_within_window_then_allows_after_it_elapses()
    {
        var clock = Clock();
        var limiter = Build(clock, new SocialRateLimitOptions { PostCooldownSeconds = 30, PostsPerWindow = 10, WindowSeconds = 3600 });

        Assert.True((await limiter.CheckAsync("a", SocialQuota.Post, CancellationToken.None)).Allowed);
        await limiter.RecordAsync("a", SocialQuota.Post, CancellationToken.None);

        var blocked = await limiter.CheckAsync("a", SocialQuota.Post, CancellationToken.None);
        Assert.False(blocked.Allowed);
        Assert.True(blocked.RetryAfterSeconds > 0);

        clock.Advance(TimeSpan.FromSeconds(31));
        Assert.True((await limiter.CheckAsync("a", SocialQuota.Post, CancellationToken.None)).Allowed);
    }

    [Fact]
    public async Task Window_quota_blocks_after_the_limit_and_is_per_account()
    {
        var clock = Clock();
        var limiter = Build(clock, new SocialRateLimitOptions { PostCooldownSeconds = 0, FollowsPerWindow = 2, WindowSeconds = 3600 });

        await limiter.RecordAsync("a", SocialQuota.Follow, CancellationToken.None);
        await limiter.RecordAsync("a", SocialQuota.Follow, CancellationToken.None);

        Assert.False((await limiter.CheckAsync("a", SocialQuota.Follow, CancellationToken.None)).Allowed);
        // Another account has its own bucket.
        Assert.True((await limiter.CheckAsync("b", SocialQuota.Follow, CancellationToken.None)).Allowed);
    }

    [Fact]
    public async Task Headers_report_limit_and_remaining()
    {
        var clock = Clock();
        var limiter = Build(clock, new SocialRateLimitOptions { PostCooldownSeconds = 0, ReactionsPerWindow = 5, WindowSeconds = 3600 });

        var before = await limiter.CheckAsync("a", SocialQuota.Reaction, CancellationToken.None);
        Assert.Equal(5, before.Headers.Limit);
        Assert.Equal(5, before.Headers.Remaining);

        await limiter.RecordAsync("a", SocialQuota.Reaction, CancellationToken.None);
        var after = await limiter.CheckAsync("a", SocialQuota.Reaction, CancellationToken.None);
        Assert.Equal(4, after.Headers.Remaining);
    }
}
