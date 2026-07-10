using System.Collections.Concurrent;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.InMemory;

/// <summary>
/// In-memory idempotency store. <see cref="PutIfAbsentAsync"/> stores atomically and always
/// returns the record that owns the scope, so a concurrent replay observes the winner.
/// </summary>
public sealed class InMemoryIdempotencyStore : IIdempotencyStore
{
    private readonly ConcurrentDictionary<string, IdempotencyRecord> _byScope = new(StringComparer.Ordinal);

    public Task<IdempotencyRecord?> GetAsync(string scope, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        return Task.FromResult(_byScope.TryGetValue(scope, out var record) ? record : null);
    }

    public Task<IdempotencyRecord> PutIfAbsentAsync(IdempotencyRecord record, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var winner = _byScope.GetOrAdd(record.Scope, record);
        return Task.FromResult(winner);
    }
}
