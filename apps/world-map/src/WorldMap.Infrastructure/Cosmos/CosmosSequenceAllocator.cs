using System.Net;
using System.Text.Json.Serialization;
using Microsoft.Azure.Cosmos;

namespace WorldMap.Infrastructure.Cosmos;

/// <summary>
/// Atomic monotonic sequence/ordinal allocator for a single logical stream (the global world-event
/// sequence, a per-civ command sequence, or a civ/relationship ordinal).
///
/// <para><b>Single-instance correctness.</b> Assignment and the record insert are serialized under an
/// in-process <see cref="SemaphoreSlim"/> (allocate-through-insert): a number is committed to the
/// backing counter ONLY after the record it names is durably inserted, so a reader's forward-only
/// cursor can never advance past a not-yet-committed record, and a create-conflict dedupe never
/// burns a number. The high-water mark is persisted to a counter document so it survives restarts;
/// on first use it is seeded from the greater of the persisted counter and a live <c>MAX</c> scan of
/// the target container (recovering a crash between insert and counter write). This is correct for a
/// SINGLE writer instance; horizontal scale-out would require a server-side atomic counter (e.g. a
/// stored procedure or a lease) instead.</para>
/// </summary>
internal sealed class CosmosSequenceAllocator(Container counters, string stream)
{
    private readonly SequenceAllocatorCore _core = new();
    private readonly string _id = CosmosId.Hash(stream);
    private readonly PartitionKey _pk = new(stream);

    /// <summary>
    /// Allocates the next value and runs <paramref name="insert"/> to persist the named record. Delegates
    /// the gate/seed/allocate-through-insert + ambiguous-failure reseed to <see cref="SequenceAllocatorCore"/>;
    /// the seed reads the greater of the persisted counter and the caller's live MAX scan.
    /// </summary>
    public Task<T> AllocateAsync<T>(
        Func<CancellationToken, Task<long>> seedFromMax,
        Func<long, CancellationToken, Task<SequenceInsert<T>>> insert,
        CancellationToken ct)
        => _core.AllocateAsync(
            async token => Math.Max(await ReadCounterAsync(token).ConfigureAwait(false), await seedFromMax(token).ConfigureAwait(false)),
            insert,
            WriteCounterAsync,
            ct);

    private async Task<long> ReadCounterAsync(CancellationToken ct)
    {
        try
        {
            var response = await counters.ReadItemAsync<CosmosDoc<CosmosSequenceCounter>>(_id, _pk, cancellationToken: ct)
                .ConfigureAwait(false);
            return response.Resource.Payload.Value;
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            return 0;
        }
    }

    private async Task WriteCounterAsync(long value, CancellationToken ct)
    {
        // ETag/conditional increment — never a blind upsert — so a brief two-writer overlap can never
        // lower the counter or duplicate a value. The counter is only a restart optimization (the
        // MAX-scan seed recovers it), so a lost race here is harmless.
        for (var attempt = 0; attempt < 3; attempt++)
        {
            CosmosDoc<CosmosSequenceCounter>? existing = null;
            try
            {
                var read = await counters.ReadItemAsync<CosmosDoc<CosmosSequenceCounter>>(_id, _pk, cancellationToken: ct)
                    .ConfigureAwait(false);
                existing = read.Resource;
            }
            catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
            {
                // No counter yet — create it below.
            }

            if (existing is null)
            {
                try
                {
                    var doc = CosmosDoc.Create(_id, stream, new CosmosSequenceCounter { Stream = stream, Value = value });
                    await counters.CreateItemAsync(doc, _pk, cancellationToken: ct).ConfigureAwait(false);
                    return;
                }
                catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.Conflict)
                {
                    continue; // Another writer created it first — re-read and re-evaluate.
                }
            }

            if (existing.Payload.Value >= value)
            {
                return; // Already at or past this value — never move the counter backwards.
            }

            existing.Payload.Value = value;
            try
            {
                var options = new ItemRequestOptions { IfMatchEtag = existing.Etag };
                await counters.ReplaceItemAsync(existing, _id, _pk, options, ct).ConfigureAwait(false);
                return;
            }
            catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.PreconditionFailed)
            {
                // Lost the race — re-read and retry.
            }
        }
    }
}

/// <summary>Outcome of a sequence allocator insert callback.</summary>
/// <param name="Consumed">True when the allocated value was durably used (advance the counter).</param>
/// <param name="Result">The value returned to the allocator caller.</param>
internal readonly record struct SequenceInsert<T>(bool Consumed, T Result);

/// <summary>Persisted high-water mark for a sequence stream (stored in the <c>sequences</c> container).</summary>
internal sealed class CosmosSequenceCounter
{
    [JsonPropertyName("stream")]
    public string Stream { get; set; } = default!;

    [JsonPropertyName("value")]
    public long Value { get; set; }
}
