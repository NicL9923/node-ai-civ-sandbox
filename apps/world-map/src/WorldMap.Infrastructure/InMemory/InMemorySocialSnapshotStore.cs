using WorldMap.Core.Abstractions;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.InMemory;

/// <summary>
/// Thread-safe in-memory following-feed snapshot store. Create-if-absent (idempotent by the deterministic
/// snapshot id). Expiry is enforced by the caller against its clock; this store retains the record.
/// </summary>
public sealed class InMemorySocialSnapshotStore : ISocialSnapshotStore
{
    private readonly Dictionary<string, SocialSnapshot> _byId = new(StringComparer.Ordinal);
    private readonly Lock _gate = new();

    public Task<SocialSnapshot?> GetAsync(string snapshotId, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            return Task.FromResult(_byId.TryGetValue(snapshotId, out var s) ? InMemoryClone.Copy(s) : null);
        }
    }

    public Task UpsertAsync(SocialSnapshot snapshot, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            // Idempotent create: a deterministic id maps to a stable followed-set at a fixed high-watermark.
            _byId.TryAdd(snapshot.SnapshotId, InMemoryClone.Copy(snapshot));
            return Task.CompletedTask;
        }
    }
}

/// <summary>Thread-safe in-memory per-account rate-limit state store (TTL is a no-op in memory).</summary>
public sealed class InMemorySocialRateLimitStore : ISocialRateLimitStore
{
    private readonly Dictionary<string, SocialRateLimitState> _byId = new(StringComparer.Ordinal);
    private readonly Lock _gate = new();

    public Task<SocialRateLimitState?> GetAsync(string accountId, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            return Task.FromResult(_byId.TryGetValue(accountId, out var s) ? InMemoryClone.Copy(s) : null);
        }
    }

    public Task UpsertAsync(SocialRateLimitState state, DateTimeOffset expiresAt, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            _byId[state.AccountId] = InMemoryClone.Copy(state);
            return Task.CompletedTask;
        }
    }
}
