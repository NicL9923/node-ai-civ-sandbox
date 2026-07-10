using System.Collections.Concurrent;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.InMemory;

/// <summary>
/// Thread-safe in-memory public world-event ledger keyed by <c>EventId</c>, with a
/// secondary index over <c>DedupeKey</c> for at-most-once ingestion.
/// </summary>
public sealed class InMemoryWorldEventRepository : IWorldEventRepository
{
    private readonly ConcurrentDictionary<string, WorldEvent> _byId = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, string> _dedupeToId = new(StringComparer.Ordinal);

    public Task AddAsync(WorldEvent worldEvent, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        _byId[worldEvent.EventId] = worldEvent;
        _dedupeToId[worldEvent.DedupeKey] = worldEvent.EventId;
        return Task.CompletedTask;
    }

    public Task<WorldEvent?> GetByDedupeAsync(string dedupeKey, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (_dedupeToId.TryGetValue(dedupeKey, out var id) && _byId.TryGetValue(id, out var evt))
        {
            return Task.FromResult<WorldEvent?>(evt);
        }

        return Task.FromResult<WorldEvent?>(null);
    }

    public Task<Page<WorldEvent>> ListAsync(long afterSequence, int limit, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var items = _byId.Values
            .Where(e => e.Worldsequence > afterSequence)
            .OrderBy(e => e.Worldsequence)
            .Take(limit)
            .ToList();

        long? next = limit > 0 && items.Count == limit ? items[^1].Worldsequence : null;
        return Task.FromResult(new Page<WorldEvent>(items, next));
    }
}
