using WorldMap.Infrastructure.Cosmos;
using Xunit;

namespace WorldMap.UnitTests.Infrastructure;

/// <summary>
/// Global-sequence uniqueness under ambiguous insert failures. The allocator must never re-propose a
/// possibly-consumed number after an insert throws (timeout/5xx/cancellation may have committed the record).
/// </summary>
public sealed class SequenceAllocatorCoreTests
{
    private static readonly CancellationToken CT = CancellationToken.None;

    private sealed class FakeStore
    {
        public readonly SortedSet<long> Committed = [];
        public long Counter;

        public Task<long> ReadSeed(CancellationToken ct) =>
            Task.FromResult(Math.Max(Counter, Committed.Count > 0 ? Committed.Max : 0));

        public Task Persist(long value, CancellationToken ct)
        {
            Counter = Math.Max(Counter, value);
            return Task.CompletedTask;
        }
    }

    // (a) Insert commits then throws (ambiguous): the next DISTINCT allocation gets N+1, never the same N.
    [Fact]
    public async Task Commit_then_throw_never_reuses_the_committed_sequence()
    {
        var core = new SequenceAllocatorCore();
        var store = new FakeStore();

        long proposed1 = 0;
        await Assert.ThrowsAsync<InvalidOperationException>(() => core.AllocateAsync<long>(
            store.ReadSeed,
            (next, ct) => { proposed1 = next; store.Committed.Add(next); throw new InvalidOperationException("ambiguous timeout after commit"); },
            store.Persist,
            CT));
        Assert.Equal(1, proposed1);

        long proposed2 = 0;
        var result = await core.AllocateAsync<long>(
            store.ReadSeed,
            (next, ct) => { proposed2 = next; store.Committed.Add(next); return Task.FromResult(new SequenceInsert<long>(true, next)); },
            store.Persist,
            CT);

        Assert.Equal(2, proposed2); // reseeded from the committed MAX (1) — never re-proposes 1
        Assert.Equal(2, result);
    }

    // (c) Insert throws BEFORE committing: the number is free and may be safely reused (no artificial gap).
    [Fact]
    public async Task Failure_before_commit_may_reuse_the_number_without_a_gap()
    {
        var core = new SequenceAllocatorCore();
        var store = new FakeStore();

        long proposed1 = 0;
        await Assert.ThrowsAsync<InvalidOperationException>(() => core.AllocateAsync<long>(
            store.ReadSeed,
            (next, ct) => { proposed1 = next; throw new InvalidOperationException("failed before commit"); }, // no commit
            store.Persist,
            CT));
        Assert.Equal(1, proposed1);

        long proposed2 = 0;
        await core.AllocateAsync<long>(
            store.ReadSeed,
            (next, ct) => { proposed2 = next; store.Committed.Add(next); return Task.FromResult(new SequenceInsert<long>(true, next)); },
            store.Persist,
            CT);

        Assert.Equal(1, proposed2); // nothing committed -> reseed sees 0 -> reuse 1
    }

    // (d) The counter (best-effort) write failing after a durable insert must not cause reuse.
    [Fact]
    public async Task Counter_write_failure_after_consumed_does_not_reuse()
    {
        var core = new SequenceAllocatorCore();
        var store = new FakeStore();

        await core.AllocateAsync<long>(
            store.ReadSeed,
            (next, ct) => { store.Committed.Add(next); return Task.FromResult(new SequenceInsert<long>(true, next)); },
            (value, ct) => throw new InvalidOperationException("counter write failed"), // best-effort persist fails
            CT);

        long proposed2 = 0;
        await core.AllocateAsync<long>(
            store.ReadSeed,
            (next, ct) => { proposed2 = next; store.Committed.Add(next); return Task.FromResult(new SequenceInsert<long>(true, next)); },
            store.Persist,
            CT);

        Assert.Equal(2, proposed2); // consumed advanced the in-memory authority despite the counter failure
    }

    // A non-consumed insert (idempotent dedupe conflict) releases the number for reuse.
    [Fact]
    public async Task Not_consumed_insert_releases_the_number()
    {
        var core = new SequenceAllocatorCore();
        var store = new FakeStore();

        await core.AllocateAsync<long>(store.ReadSeed, (next, ct) => Task.FromResult(new SequenceInsert<long>(false, 42)), store.Persist, CT);

        long proposed2 = 0;
        await core.AllocateAsync<long>(
            store.ReadSeed,
            (next, ct) => { proposed2 = next; store.Committed.Add(next); return Task.FromResult(new SequenceInsert<long>(true, next)); },
            store.Persist,
            CT);

        Assert.Equal(1, proposed2); // the released number is reused
    }

    // Cancellation raised during the insert is not swallowed and still invalidates the seed.
    [Fact]
    public async Task Cancellation_during_insert_is_surfaced_and_reseeds()
    {
        var core = new SequenceAllocatorCore();
        var store = new FakeStore();

        // The insert commits (ambiguously) and then surfaces a cancellation — it must propagate, not be
        // swallowed, and must invalidate the seed.
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => core.AllocateAsync<long>(
            store.ReadSeed,
            (next, ct) => { store.Committed.Add(next); throw new OperationCanceledException(); },
            store.Persist,
            CT));

        // A later allocation reseeds from the committed MAX and never re-proposes the ambiguous number.
        long proposed = 0;
        await core.AllocateAsync<long>(
            store.ReadSeed,
            (next, ct) => { proposed = next; store.Committed.Add(next); return Task.FromResult(new SequenceInsert<long>(true, next)); },
            store.Persist,
            CT);
        Assert.Equal(2, proposed);
    }

    // Interleaved allocations are strictly monotonic with no duplicates.
    [Fact]
    public async Task Interleaved_allocations_are_monotonic_and_unique()
    {
        var core = new SequenceAllocatorCore();
        var store = new FakeStore();
        var assigned = new List<long>();

        for (var i = 0; i < 5; i++)
        {
            await core.AllocateAsync<long>(
                store.ReadSeed,
                (next, ct) => { store.Committed.Add(next); return Task.FromResult(new SequenceInsert<long>(true, next)); },
                store.Persist,
                CT);
            assigned.Add(store.Committed.Max);
        }

        Assert.Equal([1, 2, 3, 4, 5], assigned);
        Assert.Equal(assigned.Count, assigned.Distinct().Count());
    }

    // An Occupied outcome (a different record already holds the proposed value, proven via the unique key)
    // advances past it and retries at the next — never returning a duplicate, no gap beyond the occupied one.
    [Fact]
    public async Task Occupied_outcome_advances_past_the_consumed_value_and_retries()
    {
        var core = new SequenceAllocatorCore();
        var store = new FakeStore { Counter = 0 };
        store.Committed.Add(1); // seq 1 is already owned by a different record (e.g. an ambiguous prior commit)

        // Seed is stale (0), so the first proposal is 1 — occupied. The core must advance to 2.
        var proposals = new List<long>();
        var result = await core.AllocateAsync<long>(
            _ => Task.FromResult(0L), // deliberately stale seed
            (next, ct) =>
            {
                proposals.Add(next);
                if (store.Committed.Contains(next))
                {
                    return Task.FromResult(SequenceInsert<long>.Occupied());
                }

                store.Committed.Add(next);
                return Task.FromResult(new SequenceInsert<long>(true, next));
            },
            store.Persist,
            CT);

        Assert.Equal([1, 2], proposals); // proposed 1 (occupied) then 2 (consumed)
        Assert.Equal(2, result);
    }
}
