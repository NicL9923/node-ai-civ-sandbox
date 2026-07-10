using WorldMap.Core.Abstractions;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.InMemory;

/// <summary>
/// Thread-safe in-memory civilization registry. Assigns a stable monotonic <c>Ordinal</c> at first
/// insert under a lock (allocate-through-insert), so list pagination never exposes a cursor position
/// past a civ that is not yet persisted.
/// </summary>
public sealed class InMemoryCivilizationRepository : ICivilizationRepository
{
    private readonly Dictionary<string, Civilization> _byCivId = new(StringComparer.Ordinal);
    private readonly Lock _gate = new();
    private long _ordinal;

    public Task<Civilization?> GetAsync(string civId, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            return Task.FromResult(_byCivId.TryGetValue(civId, out var civ) ? InMemoryClone.Copy(civ) : null);
        }
    }

    public Task UpsertAsync(Civilization civilization, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            var copy = InMemoryClone.Copy(civilization);
            if (_byCivId.TryGetValue(copy.CivId, out var existing))
            {
                copy.Ordinal = existing.Ordinal; // Ordinal is assigned once, at first insert.
            }
            else
            {
                copy.Ordinal = ++_ordinal;
            }

            _byCivId[copy.CivId] = copy;
        }

        return Task.CompletedTask;
    }

    public Task<Page<Civilization>> ListAsync(long afterOrdinal, int limit, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            var items = _byCivId.Values
                .Where(c => c.Ordinal > afterOrdinal)
                .OrderBy(c => c.Ordinal)
                .Take(limit)
                .Select(InMemoryClone.Copy)
                .ToList();

            long? next = items.Count == limit && items.Count > 0 ? items[^1].Ordinal : null;
            return Task.FromResult(new Page<Civilization>(items, next));
        }
    }

    public Task<IReadOnlyList<Civilization>> ListAllAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            IReadOnlyList<Civilization> all = _byCivId.Values.Select(InMemoryClone.Copy).ToList();
            return Task.FromResult(all);
        }
    }
}
