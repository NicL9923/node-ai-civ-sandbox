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

        var won = await store.ClaimAsync("scope", "fp", now, expires, default);
        Assert.Equal(IdempotencyClaimOutcome.Won, won.Outcome);
        Assert.Equal(IdempotencyClaimOutcome.AlreadyPending,
            (await store.ClaimAsync("scope", "fp", now, expires, default)).Outcome);
        Assert.Equal(IdempotencyClaimOutcome.FingerprintConflict,
            (await store.ClaimAsync("scope", "other", now, expires, default)).Outcome);

        await store.CompleteAsync("scope", "fp", won.Record.LeaseToken, "{}", 202, "/x", now, default);
        var completed = await store.ClaimAsync("scope", "fp", now, expires, default);
        Assert.Equal(IdempotencyClaimOutcome.Completed, completed.Outcome);
        Assert.Equal(IdempotencyState.Completed, completed.Record.State);
    }

    [Fact]
    public async Task IdempotencyStore_DifferentFingerprintConflictsForFullTtl_EvenAfterLeaseExpiry()
    {
        var clock = new FakeTimeProvider();
        var store = new InMemoryIdempotencyStore(clock);
        var now = clock.GetUtcNow();
        var ttlExpires = now.AddMinutes(10);

        await store.ClaimAsync("scope", "fp-A", now, ttlExpires, default);

        // Before the lease elapses: a different fingerprint conflicts.
        Assert.Equal(IdempotencyClaimOutcome.FingerprintConflict,
            (await store.ClaimAsync("scope", "fp-B", clock.GetUtcNow(), ttlExpires, default)).Outcome);

        // After the lease elapses (but within the idempotency TTL): STILL a conflict for a different
        // fingerprint — the pending record persists for the full TTL, not just the lease.
        clock.Advance(InMemoryIdempotencyStore.PendingLease + TimeSpan.FromSeconds(1));
        Assert.NotNull(await store.GetAsync("scope", default));
        Assert.Equal(IdempotencyClaimOutcome.FingerprintConflict,
            (await store.ClaimAsync("scope", "fp-B", clock.GetUtcNow(), ttlExpires, default)).Outcome);

        // Only the SAME fingerprint may reclaim the expired-lease pending claim.
        Assert.Equal(IdempotencyClaimOutcome.Won,
            (await store.ClaimAsync("scope", "fp-A", clock.GetUtcNow(), ttlExpires, default)).Outcome);
    }

    [Fact]
    public async Task IdempotencyStore_StaleOwnerCannotOverwriteAfterLeaseTakeover()
    {
        var clock = new FakeTimeProvider();
        var store = new InMemoryIdempotencyStore(clock);
        var now = clock.GetUtcNow();
        var ttlExpires = now.AddMinutes(10);

        var first = await store.ClaimAsync("scope", "fp", now, ttlExpires, default);

        clock.Advance(InMemoryIdempotencyStore.PendingLease + TimeSpan.FromSeconds(1));
        var takeover = await store.ClaimAsync("scope", "fp", clock.GetUtcNow(), ttlExpires, default);
        Assert.Equal(IdempotencyClaimOutcome.Won, takeover.Outcome);
        Assert.NotEqual(first.Record.LeaseToken, takeover.Record.LeaseToken);

        // The original (crashed) owner completing with its STALE token must not overwrite.
        await store.CompleteAsync("scope", "fp", first.Record.LeaseToken, "{\"stale\":true}", 200, null, clock.GetUtcNow(), default);
        Assert.Equal(IdempotencyState.Pending, (await store.GetAsync("scope", default))!.State);

        // The new owner completes successfully.
        await store.CompleteAsync("scope", "fp", takeover.Record.LeaseToken, "{\"ok\":true}", 200, null, clock.GetUtcNow(), default);
        var completed = await store.ClaimAsync("scope", "fp", clock.GetUtcNow(), ttlExpires, default);
        Assert.Equal(IdempotencyClaimOutcome.Completed, completed.Outcome);
        Assert.Equal("{\"ok\":true}", completed.Record.ResponseJson);
    }

    [Fact]
    public async Task IdempotencyStore_ScopeIsFreeOnlyAfterFullTtl()
    {
        var clock = new FakeTimeProvider();
        var store = new InMemoryIdempotencyStore(clock);
        var now = clock.GetUtcNow();

        await store.ClaimAsync("scope", "fp", now, now.AddMinutes(1), default);
        clock.Advance(TimeSpan.FromMinutes(2)); // past the full idempotency TTL

        Assert.Null(await store.GetAsync("scope", default));
        Assert.Equal(IdempotencyClaimOutcome.Won,
            (await store.ClaimAsync("scope", "new-fp", clock.GetUtcNow(), clock.GetUtcNow().AddMinutes(1), default)).Outcome);
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
    public async Task OnboardingTokenStore_ReservesOnceThenReplaysOrConflictsByFingerprint()
    {
        var store = new InMemoryOnboardingTokenStore();

        Assert.Equal(OnboardingReservationOutcome.Reserved, await store.ReserveAsync("hash", "civ-a", "fp-1", default));
        // Same token + same fingerprint replays (even under a different HTTP key at the caller).
        Assert.Equal(OnboardingReservationOutcome.DuplicateMatch, await store.ReserveAsync("hash", "civ-a", "fp-1", default));
        // Same token + different fingerprint conflicts and never re-binds the civ.
        Assert.Equal(OnboardingReservationOutcome.Conflict, await store.ReserveAsync("hash", "civ-a", "fp-2", default));
    }

    [Fact]
    public async Task WriterLeaseStore_TwoInstances_OneHoldsUntilExpiryOrRelease()
    {
        var lease = new InMemoryWriterLeaseStore();
        var t0 = DateTimeOffset.UnixEpoch;
        var duration = TimeSpan.FromSeconds(30);

        // Instance A acquires; B is rejected while A's lease is live.
        Assert.True(await lease.TryAcquireOrRenewAsync("A", t0, duration, default));
        Assert.False(await lease.TryAcquireOrRenewAsync("B", t0, duration, default));
        Assert.True(await lease.TryAcquireOrRenewAsync("A", t0.AddSeconds(10), duration, default)); // A renews

        // After A's lease expires, B can take over; A is then rejected.
        Assert.True(await lease.TryAcquireOrRenewAsync("B", t0.AddSeconds(45), duration, default));
        Assert.False(await lease.TryAcquireOrRenewAsync("A", t0.AddSeconds(46), duration, default));

        // A best-effort release lets a peer take over immediately.
        await lease.ReleaseAsync("B", t0.AddSeconds(50), default);
        Assert.True(await lease.TryAcquireOrRenewAsync("A", t0.AddSeconds(50), duration, default));
    }
}
