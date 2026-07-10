using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using WorldMap.Core.Sequencing;

namespace WorldMap.Infrastructure.InMemory;

/// <summary>
/// In-memory monotonic sequence allocator. The global worldsequence and each per-civ command
/// sequence start at 0, so the first allocated value is 1. Correct for the single-instance MVP.
/// </summary>
public sealed class InMemorySequenceAllocator : ISequenceAllocator
{
    private long _worldSequence;

    // A StrongBox per civ gives a stable target for Interlocked.Increment (truly atomic,
    // unlike ConcurrentDictionary.AddOrUpdate whose update factory can run more than once).
    private readonly ConcurrentDictionary<string, StrongBox<long>> _commandSequences = new(StringComparer.Ordinal);

    public ValueTask<long> NextWorldSequenceAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        return new ValueTask<long>(Interlocked.Increment(ref _worldSequence));
    }

    public ValueTask<long> NextCommandSequenceAsync(string civId, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var box = _commandSequences.GetOrAdd(civId, static _ => new StrongBox<long>(0));
        return new ValueTask<long>(Interlocked.Increment(ref box.Value));
    }
}
