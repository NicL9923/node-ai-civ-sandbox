using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Configuration;
using WorldMap.Core.Domain;

namespace WorldMap.Core.Application;

/// <summary>
/// Durable, deterministic per-account social rate limiter. State is a store-backed sliding window keyed by
/// account id; time comes from the injected <see cref="TimeProvider"/> so tests are deterministic.
/// <see cref="CheckAsync"/> is read-only (evaluated BEFORE the idempotency claim for a new request);
/// <see cref="RecordAsync"/> consumes a permit (called INSIDE a successful mutation effect, so an
/// idempotent replay never double-consumes).
/// </summary>
public sealed class SocialRateLimiter(ISocialRateLimitStore store, TimeProvider clock, IOptions<WorldMapOptions> options)
{
    private readonly SocialRateLimitOptions _cfg = options.Value.Social.RateLimit;

    /// <summary>Evaluates whether the account may perform <paramref name="quota"/> now, without consuming.</summary>
    public async Task<SocialRateDecision> CheckAsync(string accountId, SocialQuota quota, CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        var state = await store.GetAsync(accountId, ct) ?? new SocialRateLimitState { AccountId = accountId };
        return Evaluate(state, quota, now, consume: false);
    }

    /// <summary>Consumes a permit for a successful mutation (advances the sliding window and persists it).</summary>
    public async Task RecordAsync(string accountId, SocialQuota quota, CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        var state = await store.GetAsync(accountId, ct) ?? new SocialRateLimitState { AccountId = accountId };
        Evaluate(state, quota, now, consume: true);

        // TTL covers the whole window plus the cooldown so stale state self-purges.
        var expiry = now.AddSeconds(_cfg.WindowSeconds + _cfg.PostCooldownSeconds + 5);
        await store.UpsertAsync(state, expiry, ct);
    }

    private SocialRateDecision Evaluate(SocialRateLimitState state, SocialQuota quota, DateTimeOffset now, bool consume)
    {
        var cutoff = now.AddSeconds(-_cfg.WindowSeconds);
        state.PostTimes.RemoveAll(t => t <= cutoff);
        state.ReactionTimes.RemoveAll(t => t <= cutoff);
        state.FollowTimes.RemoveAll(t => t <= cutoff);

        var (times, limit, cooldown) = quota switch
        {
            SocialQuota.Post => (state.PostTimes, _cfg.PostsPerWindow, _cfg.PostCooldownSeconds),
            SocialQuota.Reaction => (state.ReactionTimes, _cfg.ReactionsPerWindow, 0),
            _ => (state.FollowTimes, _cfg.FollowsPerWindow, 0),
        };

        var allowed = true;
        var retryAfter = 0;

        // Per-post cooldown (applies to the Post quota only).
        if (cooldown > 0 && times.Count > 0)
        {
            var elapsed = (now - times.Max()).TotalSeconds;
            if (elapsed < cooldown)
            {
                allowed = false;
                retryAfter = Math.Max(retryAfter, (int)Math.Ceiling(cooldown - elapsed));
            }
        }

        // Windowed quota.
        if (times.Count >= limit)
        {
            allowed = false;
            var untilFree = _cfg.WindowSeconds - (now - times.Min()).TotalSeconds;
            retryAfter = Math.Max(retryAfter, (int)Math.Ceiling(Math.Max(1, untilFree)));
        }

        if (consume && allowed)
        {
            times.Add(now);
        }

        var remaining = Math.Max(0, limit - times.Count);
        var reset = now.AddSeconds(_cfg.WindowSeconds).ToUnixTimeSeconds();
        if (!allowed && retryAfter < 1)
        {
            retryAfter = 1;
        }

        return new SocialRateDecision(allowed, retryAfter, new SocialRateHeaders(limit, remaining, reset));
    }
}
