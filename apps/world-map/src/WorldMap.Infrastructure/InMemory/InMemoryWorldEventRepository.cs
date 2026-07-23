using WorldMap.Core.Abstractions;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.InMemory;

/// <summary>
/// Thread-safe in-memory world-event ledger. <see cref="AppendAsync"/> assigns the global
/// <c>Worldsequence</c> and inserts atomically under a lock (allocate-through-insert), idempotent by
/// <c>DedupeKey</c>. Because assignment and insertion are one critical section, the read cursor can
/// never advance past a sequence whose record is not yet committed.
/// </summary>
public sealed class InMemoryWorldEventRepository : IWorldEventRepository
{
    private readonly List<WorldEvent> _ordered = [];
    private readonly Dictionary<string, WorldEvent> _byDedupe = new(StringComparer.Ordinal);
    private readonly Lock _gate = new();
    private long _worldsequence;

    public Task<WorldEventAppend> AppendAsync(WorldEvent worldEvent, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            if (_byDedupe.TryGetValue(worldEvent.DedupeKey, out var existing))
            {
                return Task.FromResult(new WorldEventAppend(InMemoryClone.Copy(existing), true));
            }

            var copy = InMemoryClone.Copy(worldEvent);
            copy.Worldsequence = ++_worldsequence;
            _ordered.Add(copy);
            _byDedupe[copy.DedupeKey] = copy;
            return Task.FromResult(new WorldEventAppend(InMemoryClone.Copy(copy), false));
        }
    }

    public Task<WorldEventAppend> AppendAsync(WorldEvent template, Func<long, System.Text.Json.Nodes.JsonNode?> buildPublicData, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            if (_byDedupe.TryGetValue(template.DedupeKey, out var existing))
            {
                return Task.FromResult(new WorldEventAppend(InMemoryClone.Copy(existing), true));
            }

            // Reserve the sequence, then build the public data FROM it so the embedded post worldsequence
            // equals this event's envelope worldsequence.
            var ws = ++_worldsequence;
            var copy = InMemoryClone.Copy(template);
            copy.Worldsequence = ws;
            copy.PublicData = buildPublicData(ws);
            _ordered.Add(copy);
            _byDedupe[copy.DedupeKey] = copy;
            return Task.FromResult(new WorldEventAppend(InMemoryClone.Copy(copy), false));
        }
    }

    public Task<WorldEvent?> GetByDedupeAsync(string dedupeKey, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            return Task.FromResult(_byDedupe.TryGetValue(dedupeKey, out var e) ? InMemoryClone.Copy(e) : null);
        }
    }

    public Task<Page<WorldEvent>> ListAsync(long afterSequence, int limit, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            var items = _ordered
                .Where(e => e.Worldsequence > afterSequence)
                .OrderBy(e => e.Worldsequence)
                .Take(limit)
                .Select(InMemoryClone.Copy)
                .ToList();

            long? next = items.Count == limit && items.Count > 0 ? items[^1].Worldsequence : null;
            return Task.FromResult(new Page<WorldEvent>(items, next));
        }
    }
}
