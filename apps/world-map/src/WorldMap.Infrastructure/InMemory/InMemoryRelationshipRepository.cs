using WorldMap.Core.Abstractions;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.InMemory;

/// <summary>
/// Thread-safe in-memory relationship projection store. Assigns a stable <c>Ordinal</c> at first
/// insert; <see cref="TryUpsertAsync"/> is a monotonic-version CAS so a concurrent update cannot
/// clobber a newer state.
/// </summary>
public sealed class InMemoryRelationshipRepository : IRelationshipRepository
{
    private readonly Dictionary<string, Relationship> _byPair = new(StringComparer.Ordinal);
    private readonly Lock _gate = new();
    private long _ordinal;

    public Task<Relationship?> GetAsync(string pairKey, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            return Task.FromResult(_byPair.TryGetValue(pairKey, out var r) ? InMemoryClone.Copy(r) : null);
        }
    }

    public Task<bool> TryUpsertAsync(Relationship relationship, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            if (_byPair.TryGetValue(relationship.PairKey, out var stored))
            {
                if (stored.Version >= relationship.Version)
                {
                    return Task.FromResult(false); // Stale write.
                }

                var updated = InMemoryClone.Copy(relationship);
                updated.Ordinal = stored.Ordinal; // Ordinal fixed at first insert.
                _byPair[relationship.PairKey] = updated;
                return Task.FromResult(true);
            }

            var inserted = InMemoryClone.Copy(relationship);
            inserted.Ordinal = ++_ordinal;
            _byPair[relationship.PairKey] = inserted;
            return Task.FromResult(true);
        }
    }

    public Task<Page<Relationship>> ListAsync(long afterOrdinal, int limit, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            var items = _byPair.Values
                .Where(r => r.Ordinal > afterOrdinal)
                .OrderBy(r => r.Ordinal)
                .Take(limit)
                .Select(InMemoryClone.Copy)
                .ToList();

            long? next = items.Count == limit && items.Count > 0 ? items[^1].Ordinal : null;
            return Task.FromResult(new Page<Relationship>(items, next));
        }
    }
}
