using Microsoft.Extensions.Time.Testing;
using WorldMap.Core.Domain;
using WorldMap.Infrastructure.InMemory;

namespace WorldMap.UnitTests.Infrastructure;

public sealed class StoreLifecycleTests
{
    [Fact]
    public async Task IdempotencyStore_TransitionsAcrossAllClaimOutcomes()
    {
        var clock = new FakeTimeProvider();
        var store = new InMemoryIdempotencyStore(clock);
        var now = clock.GetUtcNow();
        var expires = now.AddMinutes(1);

        Assert.Equal(IdempotencyClaimOutcome.Won,
            (await store.ClaimAsync("scope", "fp", now, expires, default)).Outcome);
        Assert.Equal(IdempotencyClaimOutcome.AlreadyPending,
            (await store.ClaimAsync("scope", "fp", now, expires, default)).Outcome);
        Assert.Equal(IdempotencyClaimOutcome.FingerprintConflict,
            (await store.ClaimAsync("scope", "other", now, expires, default)).Outcome);

        await store.CompleteAsync("scope", "fp", "{}", 202, "/x", now, default);
        var completed = await store.ClaimAsync("scope", "fp", now, expires, default);
        Assert.Equal(IdempotencyClaimOutcome.Completed, completed.Outcome);
        Assert.Equal(IdempotencyState.Completed, completed.Record.State);
    }

    [Fact]
    public async Task IdempotencyStore_PendingReclaimableAfterLease_CompletedExpiresAfterTtl()
    {
        var clock = new FakeTimeProvider();
        var store = new InMemoryIdempotencyStore(clock);
        var now = clock.GetUtcNow();

        // A pending claim holds its lease (crash-recovery window), not just the operation ttl.
        await store.ClaimAsync("scope", "fp", now, now.AddSeconds(1), default);
        Assert.Equal(IdempotencyClaimOutcome.AlreadyPending,
            (await store.ClaimAsync("scope", "fp", clock.GetUtcNow(), clock.GetUtcNow().AddSeconds(1), default)).Outcome);

        // After the pending lease elapses, another caller atomically reclaims it.
        clock.Advance(InMemoryIdempotencyStore.PendingLease + TimeSpan.FromSeconds(1));
        Assert.Null(await store.GetAsync("scope", default));
        Assert.Equal(IdempotencyClaimOutcome.Won,
            (await store.ClaimAsync("scope", "new-fp", clock.GetUtcNow(), clock.GetUtcNow().AddMinutes(1), default)).Outcome);

        // A COMPLETED record is replayable until its full expiry, then disappears.
        var t = clock.GetUtcNow();
        await store.CompleteAsync("scope", "new-fp", "{}", 200, null, t, default);
        clock.Advance(TimeSpan.FromMinutes(2));
        Assert.Null(await store.GetAsync("scope", default));
    }

    [Fact]
    public async Task NonceStore_ScopesByCivilizationAndAllowsReuseAfterExpiry()
    {
        var store = new InMemoryNonceStore();
        var now = DateTimeOffset.UtcNow;
        var expires = now.AddMinutes(1);

        Assert.True(await store.TryConsumeAsync("a", "key", "nonce", expires, now, default));
        Assert.False(await store.TryConsumeAsync("a", "key", "nonce", expires, now, default));
        Assert.True(await store.TryConsumeAsync("b", "key", "nonce", expires, now, default));
        Assert.True(await store.TryConsumeAsync("a", "key", "nonce", now.AddMinutes(2), expires.AddTicks(1), default));
    }

    [Fact]
    public async Task OnboardingTokenStore_IsIdempotentOnlyForSameCivilization()
    {
        var store = new InMemoryOnboardingTokenStore();

        Assert.True(await store.TryReserveAsync("hash", "civ-a", default));
        Assert.True(await store.TryReserveAsync("hash", "civ-a", default));
        Assert.False(await store.TryReserveAsync("hash", "civ-b", default));
    }
}
