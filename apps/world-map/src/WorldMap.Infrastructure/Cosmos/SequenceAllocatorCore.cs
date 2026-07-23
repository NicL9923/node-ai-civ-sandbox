namespace WorldMap.Infrastructure.Cosmos;

/// <summary>
/// Provider-agnostic, single-instance monotonic allocation core (gate + seed + allocate-through-insert).
/// A value is committed to the in-memory high-water mark ONLY after the record it names is durably
/// inserted. Critically, if the insert throws — including an <b>ambiguous</b> failure (timeout / 5xx /
/// cancellation) where the record MAY have committed — the in-memory seed is invalidated so the next
/// allocation re-reads the persisted counter and a live MAX scan before proposing a value, and can never
/// re-propose a possibly-consumed number with a different record id (which would duplicate the global
/// sequence). Correct for a single writer instance; scale-out would require a server-side atomic counter.
///
/// <para><b>Consistency prerequisite.</b> The reseed after an ambiguous failure relies on the caller's
/// <c>readSeed</c> (persisted counter + live MAX scan) observing the writer's own just-committed —
/// possibly un-acked — write. That requires read-your-writes for the single writer: the backing Cosmos
/// account must run at <b>Strong</b> (or single-region + single-writer <b>Session</b>) consistency. Under
/// Eventual/Bounded-Staleness the MAX scan may read a lagging replica and return a stale value, which would
/// re-open the duplicate-sequence window this class exists to close. See the World README scale-out note.</para>
/// </summary>
internal sealed class SequenceAllocatorCore
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private bool _seeded;
    private long _current;

    /// <summary>
    /// Allocates the next value under the gate and runs <paramref name="insert"/> to persist the named
    /// record. <paramref name="readSeed"/> yields the greater of the persisted counter and a live MAX scan
    /// (used on first use and after an ambiguous failure). <paramref name="persist"/> best-effort writes
    /// the high-water counter after a durable insert.
    /// </summary>
    public async Task<T> AllocateAsync<T>(
        Func<CancellationToken, Task<long>> readSeed,
        Func<long, CancellationToken, Task<SequenceInsert<T>>> insert,
        Func<long, CancellationToken, Task> persist,
        CancellationToken ct)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (!_seeded)
            {
                _current = await readSeed(ct).ConfigureAwait(false);
                _seeded = true;
            }

            var next = _current + 1;

            SequenceInsert<T> outcome;
            try
            {
                outcome = await insert(next, ct).ConfigureAwait(false);
            }
            catch
            {
                // Ambiguous: the insert may have committed at `next` before the failure surfaced. Drop the
                // in-memory seed so the NEXT allocation re-reads the persisted counter + live MAX under the
                // gate and never re-proposes a possibly-consumed number. Cancellation is not swallowed.
                _seeded = false;
                throw;
            }

            if (outcome.Consumed)
            {
                // The record is durably inserted at `next`: advance the authority FIRST so this number is
                // never reused even if the counter write fails. The counter doc is only a restart
                // optimization (the MAX-scan seed recovers it), so its write is best-effort — but a
                // cancellation must still surface.
                _current = next;
                try
                {
                    await persist(next, ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested)
                {
                    throw;
                }
                catch
                {
                    // Recoverable on the next reseed via the MAX scan.
                }
            }

            return outcome.Result;
        }
        finally
        {
            _gate.Release();
        }
    }
}
