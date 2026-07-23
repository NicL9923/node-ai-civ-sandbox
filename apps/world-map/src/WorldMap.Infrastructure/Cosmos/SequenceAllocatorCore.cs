namespace WorldMap.Infrastructure.Cosmos;

/// <summary>
/// Provider-agnostic, single-instance monotonic allocation core (gate + seed + allocate-through-insert).
/// A value is committed to the in-memory high-water mark ONLY after the record it names is durably
/// inserted. If the insert throws — including an <b>ambiguous</b> failure (timeout / 5xx / cancellation)
/// where the record MAY have committed — the in-memory seed is invalidated so the next allocation re-reads
/// the persisted counter and a live MAX scan before proposing a value. Correct for a single writer
/// instance; scale-out would require a server-side atomic counter.
///
/// <para><b>Structural uniqueness backstop.</b> The seed reads MAX under the account's own consistency and
/// so may momentarily lag an ambiguously-committed write. The definitive guard is therefore NOT the read
/// consistency but a <b>structural unique key</b> on the ordinal (for world events, a Cosmos unique key on
/// <c>/payload/worldsequence</c> within the single feed partition): a re-proposed, already-consumed value
/// is rejected by the store. The insert callback observes that conflict and returns
/// <see cref="SequenceOutcome.Occupied"/>, on which this core advances past the proven-consumed value and
/// retries at the next — so a committed sequence is never reused under ANY account consistency, without an
/// artificial gap when the prior insert did not actually land.</para>
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

            while (true)
            {
                ct.ThrowIfCancellationRequested();
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

                switch (outcome.Kind)
                {
                    case SequenceOutcome.Consumed:
                        // The record is durably inserted at `next`: advance the authority FIRST so this number
                        // is never reused even if the counter write fails. The counter doc is only a restart
                        // optimization (the MAX-scan seed recovers it), so its write is best-effort — but a
                        // cancellation must still surface.
                        _current = next;
                        await PersistBestEffortAsync(persist, next, ct).ConfigureAwait(false);
                        return outcome.Result;

                    case SequenceOutcome.ReleasedDuplicate:
                        // A same-identity record already committed at an earlier value: do NOT advance, so
                        // `next` stays free for the next distinct append (no artificial gap).
                        return outcome.Result;

                    case SequenceOutcome.Occupied:
                        // A DIFFERENT record is proven (observed) to occupy `next` — e.g. after an ambiguous
                        // failure whose write actually committed, seen via the structural unique key. `next`
                        // is known-consumed: advance past it (persist best-effort) and retry at `next + 1`.
                        _current = next;
                        await PersistBestEffortAsync(persist, next, ct).ConfigureAwait(false);
                        continue;

                    default:
                        throw new InvalidOperationException($"Unhandled sequence outcome '{outcome.Kind}'.");
                }
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    private static async Task PersistBestEffortAsync(Func<long, CancellationToken, Task> persist, long value, CancellationToken ct)
    {
        try
        {
            await persist(value, ct).ConfigureAwait(false);
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
}
