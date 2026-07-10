using System.Collections.Concurrent;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.InMemory;

/// <summary>Thread-safe in-memory relationship projection store keyed by <c>PairKey</c>.</summary>
public sealed class InMemoryRelationshipRepository : IRelationshipRepository
{
    private readonly ConcurrentDictionary<string, Relationship> _byPairKey = new(StringComparer.Ordinal);

    public Task<Relationship?> GetAsync(string pairKey, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        return Task.FromResult(_byPairKey.TryGetValue(pairKey, out var rel) ? rel : null);
    }

    public Task<Page<Relationship>> ListAsync(long afterOrdinal, int limit, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var items = _byPairKey.Values
            .Where(r => r.Ordinal > afterOrdinal)
            .OrderBy(r => r.Ordinal)
            .Take(limit)
            .ToList();

        long? next = limit > 0 && items.Count == limit ? items[^1].Ordinal : null;
        return Task.FromResult(new Page<Relationship>(items, next));
    }

    public Task UpsertAsync(Relationship relationship, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        _byPairKey[relationship.PairKey] = relationship;
        return Task.CompletedTask;
    }
}
