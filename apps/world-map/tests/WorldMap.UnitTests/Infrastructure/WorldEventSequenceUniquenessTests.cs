using WorldMap.Core.Domain;
using WorldMap.Infrastructure.Cosmos;
using WorldMap.Infrastructure.InMemory;
using Xunit;

namespace WorldMap.UnitTests.Infrastructure;

/// <summary>
/// End-to-end global-sequence uniqueness backed by the structural <c>/payload/worldsequence</c> unique key.
/// Composes the REAL <see cref="SequenceAllocatorCore"/> and <see cref="WorldEventConflictResolver"/> with a
/// fake unique-key store (mirroring <c>CosmosWorldEventRepository</c>) so the ambiguous-commit / occupied /
/// dedupe-replay / bounded-invisible paths are exercised deterministically without a live Cosmos account.
/// </summary>
public sealed class WorldEventSequenceUniquenessTests
{
    private static readonly CancellationToken CT = CancellationToken.None;
    private const int MaxAttempts = 5;

    private static WorldEvent Ev(string dedupe, long seq) => new()
    {
        EventId = $"evt_{dedupe}",
        Type = "test.event",
        Source = "world://test",
        DedupeKey = dedupe,
        Worldsequence = seq,
        CreatedAt = DateTimeOffset.UnixEpoch,
    };

    /// <summary>A fake Cosmos-like store with a unique key on both the doc id and the worldsequence.</summary>
    private sealed class FakeSequencedStore
    {
        public readonly Dictionary<string, WorldEvent> ById = new(StringComparer.Ordinal);
        public readonly Dictionary<long, WorldEvent> BySeq = [];
        public long Counter;
        public long MaxOverride = -1; // >=0 forces a (possibly stale) MAX scan result
        public int HideReadsFor;      // suppress this many subsequent point/query reads (replication lag)

        public long Max() => MaxOverride >= 0 ? MaxOverride : (BySeq.Count == 0 ? 0 : BySeq.Keys.Max());
        public Task<long> Seed(CancellationToken ct) => Task.FromResult(Math.Max(Counter, Max()));
        public Task Persist(long v, CancellationToken ct) { Counter = Math.Max(Counter, v); return Task.CompletedTask; }

        // Directly commit a doc (e.g. a prior ambiguous commit) — bypasses conflict checks.
        public void Preinsert(string id, long seq) { var e = Ev(id, seq); ById[id] = e; BySeq[seq] = e; }

        public bool TryCommit(string id, long seq, WorldEvent ev)
        {
            if (ById.ContainsKey(id) || BySeq.ContainsKey(seq)) return false; // unique-key (id OR seq) violation
            ById[id] = ev;
            BySeq[seq] = ev;
            return true;
        }

        private WorldEvent? Reveal(WorldEvent? e)
        {
            if (HideReadsFor > 0) { HideReadsFor--; return null; }
            return e;
        }

        public Task<WorldEvent?> ReadById(string id, CancellationToken ct) => Task.FromResult(Reveal(ById.GetValueOrDefault(id)));
        public Task<WorldEvent?> ReadBySeq(long seq, CancellationToken ct) => Task.FromResult(Reveal(BySeq.GetValueOrDefault(seq)));
    }

    // Mirrors CosmosWorldEventRepository: allocate-through-insert + 409 resolution (no-op delay, injectable attempts).
    private static async Task<long> AppendAsync(FakeSequencedStore store, SequenceAllocatorCore core, string dedupe, CancellationToken ct)
    {
        var result = await core.AllocateAsync<WorldEvent>(
            store.Seed,
            async (next, token) =>
            {
                var ev = Ev(dedupe, next);
                if (store.TryCommit(dedupe, next, ev))
                {
                    return new SequenceInsert<WorldEvent>(true, ev);
                }

                var resolution = await WorldEventConflictResolver.ResolveAsync(
                    t => store.ReadById(dedupe, t),
                    t => store.ReadBySeq(next, t),
                    MaxAttempts,
                    (_, _) => Task.CompletedTask,
                    token);

                return resolution.Kind switch
                {
                    WorldEventConflictKind.Duplicate => SequenceInsert<WorldEvent>.ReleasedDuplicate(resolution.Existing!),
                    WorldEventConflictKind.Occupied => SequenceInsert<WorldEvent>.Occupied(),
                    _ => throw new WorldEventConflictUnresolvedException(next),
                };
            },
            store.Persist,
            ct);

        return result.Worldsequence;
    }

    // ---- Resolver unit behavior --------------------------------------------------------------------

    [Fact]
    public async Task Resolver_returns_duplicate_with_original_sequence_for_same_dedupe_conflict()
    {
        var mine = Ev("A", 7);
        var resolution = await WorldEventConflictResolver.ResolveAsync(
            _ => Task.FromResult<WorldEvent?>(mine),
            _ => Task.FromResult<WorldEvent?>(null),
            MaxAttempts, (_, _) => Task.CompletedTask, CT);

        Assert.Equal(WorldEventConflictKind.Duplicate, resolution.Kind);
        Assert.Equal(7, resolution.Existing!.Worldsequence); // replays the original sequence
    }

    [Fact]
    public async Task Resolver_returns_occupied_when_a_different_event_owns_the_sequence()
    {
        var owner = Ev("other", 3);
        var resolution = await WorldEventConflictResolver.ResolveAsync(
            _ => Task.FromResult<WorldEvent?>(null),
            _ => Task.FromResult<WorldEvent?>(owner),
            MaxAttempts, (_, _) => Task.CompletedTask, CT);

        Assert.Equal(WorldEventConflictKind.Occupied, resolution.Kind);
    }

    [Fact]
    public async Task Resolver_polls_until_a_hidden_conflict_becomes_visible()
    {
        var owner = Ev("other", 3);
        var attempts = 0;
        var resolution = await WorldEventConflictResolver.ResolveAsync(
            _ => Task.FromResult<WorldEvent?>(null),
            _ => { attempts++; return Task.FromResult<WorldEvent?>(attempts >= 3 ? owner : null); },
            MaxAttempts, (_, _) => Task.CompletedTask, CT);

        Assert.Equal(WorldEventConflictKind.Occupied, resolution.Kind);
        Assert.Equal(3, attempts);
    }

    [Fact]
    public async Task Resolver_reports_unresolved_when_conflict_never_becomes_visible()
    {
        var resolution = await WorldEventConflictResolver.ResolveAsync(
            _ => Task.FromResult<WorldEvent?>(null),
            _ => Task.FromResult<WorldEvent?>(null),
            MaxAttempts, (_, _) => Task.CompletedTask, CT);

        Assert.Equal(WorldEventConflictKind.Unresolved, resolution.Kind);
    }

    [Fact]
    public async Task Resolver_surfaces_cancellation_during_observation()
    {
        using var cts = new CancellationTokenSource();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => WorldEventConflictResolver.ResolveAsync(
            _ => Task.FromResult<WorldEvent?>(null),
            _ => { cts.Cancel(); return Task.FromResult<WorldEvent?>(null); },
            MaxAttempts,
            (_, token) => Task.Delay(Timeout.Infinite, token),
            cts.Token));
    }

    // ---- Integrated allocator + resolver + unique-key store ----------------------------------------

    // Ambiguous commit with a stale MAX: a distinct append proposes N (occupied by the committed doc),
    // observes it via the unique key, then creates N+1 — never a duplicate.
    [Fact]
    public async Task Ambiguous_commit_with_stale_max_advances_to_next_and_never_duplicates()
    {
        var store = new FakeSequencedStore();
        var core = new SequenceAllocatorCore();

        store.Preinsert("ambiguous", 1); // a prior ambiguous attempt actually committed seq 1
        store.MaxOverride = 0;       // but the MAX scan lags and reports 0

        var seq = await AppendAsync(store, core, "distinct", CT);

        Assert.Equal(2, seq); // proposed 1 (occupied) -> advanced -> committed 2
        Assert.Equal(2, store.BySeq.Count);
        Assert.Equal(store.BySeq.Count, store.BySeq.Keys.Distinct().Count()); // no duplicate ordinal
    }

    // A create conflict that never becomes observable throws a retryable error WITHOUT advancing; once the
    // conflict is visible, the retry reseeds and commits the next free sequence with no gap or duplicate.
    [Fact]
    public async Task Unresolved_conflict_throws_retryable_then_reseeds_without_gap_or_duplicate()
    {
        var store = new FakeSequencedStore();
        var core = new SequenceAllocatorCore();

        store.Preinsert("owner", 1);      // a different event owns seq 1
        store.MaxOverride = 0;        // stale MAX
        store.HideReadsFor = 1000;    // the conflicting doc is not observable within the window

        await Assert.ThrowsAsync<WorldEventConflictUnresolvedException>(() => AppendAsync(store, core, "distinct", CT));

        // Replication catches up; the retry reseeds (seed invalidated by the throw) and commits seq 2.
        store.HideReadsFor = 0;
        store.MaxOverride = -1;
        var seq = await AppendAsync(store, core, "distinct", CT);

        Assert.Equal(2, seq);
        Assert.Equal([1, 2], store.BySeq.Keys.OrderBy(k => k).ToArray()); // owner=1, distinct=2, no gap/dup
    }

    [Fact]
    public async Task Interleaved_distinct_appends_are_strictly_increasing_and_unique()
    {
        var store = new FakeSequencedStore();
        var core = new SequenceAllocatorCore();

        var seqs = new List<long>();
        foreach (var name in new[] { "social-a", "world-b", "social-c", "world-d", "social-e" })
        {
            seqs.Add(await AppendAsync(store, core, name, CT));
        }

        Assert.Equal([1, 2, 3, 4, 5], seqs);
        Assert.Equal(seqs.Count, seqs.Distinct().Count());
    }

    // ---- InMemory parity: worldsequence is structurally unique + contiguous --------------------------

    [Fact]
    public async Task InMemory_world_events_have_unique_contiguous_sequences_and_dedupe_does_not_allocate()
    {
        var repo = new InMemoryWorldEventRepository();
        var seqs = new List<long>();
        for (var i = 0; i < 6; i++)
        {
            var append = await repo.AppendAsync(Ev($"k{i}", 0), CT);
            seqs.Add(append.Event.Worldsequence);
        }

        Assert.Equal([1, 2, 3, 4, 5, 6], seqs);
        Assert.Equal(seqs.Count, seqs.Distinct().Count());

        // A dedupe replay returns the original event WITHOUT consuming a new sequence.
        var replay = await repo.AppendAsync(Ev("k3", 0), CT);
        Assert.True(replay.WasDuplicate);
        Assert.Equal(4, replay.Event.Worldsequence);
    }

    // ---- Readiness fail-closed helper ---------------------------------------------------------------

    [Fact]
    public void Readiness_requires_an_exact_standalone_worldEvents_unique_key()
    {
        // No unique key ⇒ non-compliant (fail closed).
        Assert.False(CosmosContainers.HasRequiredUniqueKey("worldEvents", []));

        // Exactly the standalone key ⇒ compliant.
        Assert.True(CosmosContainers.HasRequiredUniqueKey("worldEvents", [new[] { "/payload/worldsequence" }]));

        // A COMPOSITE key with an extra path does NOT uniquely constrain the ordinal ⇒ fail closed.
        Assert.False(CosmosContainers.HasRequiredUniqueKey("worldEvents", [new[] { "/payload/worldsequence", "/payload/other" }]));

        // A divergent path ⇒ fail closed.
        Assert.False(CosmosContainers.HasRequiredUniqueKey("worldEvents", [new[] { "/payload/other" }]));

        // The standalone key present ALONGSIDE another unrelated unique key ⇒ compliant.
        Assert.True(CosmosContainers.HasRequiredUniqueKey("worldEvents", [new[] { "/payload/other" }, new[] { "/payload/worldsequence" }]));

        // A container with no declared unique key is always compliant.
        Assert.True(CosmosContainers.HasRequiredUniqueKey("civilizations", []));
    }
}

