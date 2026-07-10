using System.Collections.Concurrent;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.InMemory;

/// <summary>
/// Thread-safe in-memory civilization registry keyed by <c>civId</c>. This is the primary
/// implementation for tests and local dev, so its pagination semantics are the reference.
/// </summary>
public sealed class InMemoryCivilizationRepository : ICivilizationRepository
{
    private readonly ConcurrentDictionary<string, Civilization> _byId = new(StringComparer.Ordinal);

    public Task<Civilization?> GetAsync(string civId, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        return Task.FromResult(_byId.TryGetValue(civId, out var civ) ? civ : null);
    }

    public Task<Page<Civilization>> ListAsync(long afterOrdinal, int limit, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var items = _byId.Values
            .Where(c => c.Ordinal > afterOrdinal)
            .OrderBy(c => c.Ordinal)
            .Take(limit)
            .ToList();

        // A full page implies more may exist; hand back a cursor. A short page is the tail.
        long? next = limit > 0 && items.Count == limit ? items[^1].Ordinal : null;
        return Task.FromResult(new Page<Civilization>(items, next));
    }

    public Task UpsertAsync(Civilization civilization, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        _byId[civilization.CivId] = civilization;
        return Task.CompletedTask;
    }

    public Task<IReadOnlyList<Civilization>> ListAllAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        return Task.FromResult<IReadOnlyList<Civilization>>(_byId.Values.ToList());
    }
}
