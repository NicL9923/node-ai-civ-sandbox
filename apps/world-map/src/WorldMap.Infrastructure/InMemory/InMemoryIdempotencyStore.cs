using WorldMap.Core.Abstractions;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.InMemory;

/// <summary>
/// Thread-safe in-memory idempotency store with the claim/complete lifecycle and a pending LEASE.
/// A pending claim can only be reclaimed once its lease elapses (owner presumed crashed), so exactly
/// one caller ever executes the effect. A completed record is replayable until its final expiry.
/// </summary>
public sealed class InMemoryIdempotencyStore(TimeProvider clock) : IIdempotencyStore
{
    /// <summary>How long a pending claim is owned before it can be reclaimed after a crash.</summary>
    public static readonly TimeSpan PendingLease = TimeSpan.FromSeconds(IdempotencyRecord.PendingLeaseSeconds);

    private readonly Dictionary<string, IdempotencyRecord> _byScope = new(StringComparer.Ordinal);
    private readonly Lock _gate = new();

    public Task<IdempotencyClaim> ClaimAsync(string scope, string fingerprint, DateTimeOffset now, DateTimeOffset expiresAt, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            PruneExpired(now);

            if (!_byScope.TryGetValue(scope, out var existing) || IsReclaimable(existing, now))
            {
                var record = new IdempotencyRecord
                {
                    Scope = scope,
                    Fingerprint = fingerprint,
                    State = IdempotencyState.Pending,
                    CreatedAt = now,
                    LeaseExpiresAt = now.Add(PendingLease),
                    ExpiresAt = expiresAt,
                };
                _byScope[scope] = record;
                return Task.FromResult(new IdempotencyClaim(IdempotencyClaimOutcome.Won, Copy(record)));
            }

            if (existing.Fingerprint != fingerprint)
            {
                return Task.FromResult(new IdempotencyClaim(IdempotencyClaimOutcome.FingerprintConflict, Copy(existing)));
            }

            var outcome = existing.State == IdempotencyState.Completed
                ? IdempotencyClaimOutcome.Completed
                : IdempotencyClaimOutcome.AlreadyPending;
            return Task.FromResult(new IdempotencyClaim(outcome, Copy(existing)));
        }
    }

    public Task CompleteAsync(string scope, string fingerprint, string responseJson, int statusCode, string? location, DateTimeOffset now, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            if (_byScope.TryGetValue(scope, out var existing) && existing.Fingerprint == fingerprint)
            {
                existing.State = IdempotencyState.Completed;
                existing.ResponseJson = responseJson;
                existing.StatusCode = statusCode;
                existing.Location = location;
            }
        }

        return Task.CompletedTask;
    }

    public Task ReleaseAsync(string scope, string fingerprint, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            if (_byScope.TryGetValue(scope, out var existing)
                && existing.State == IdempotencyState.Pending
                && existing.Fingerprint == fingerprint)
            {
                _byScope.Remove(scope);
            }
        }

        return Task.CompletedTask;
    }

    public Task<IdempotencyRecord?> GetAsync(string scope, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            var now = clock.GetUtcNow();
            if (_byScope.TryGetValue(scope, out var record) && !IsReclaimable(record, now))
            {
                return Task.FromResult<IdempotencyRecord?>(Copy(record));
            }

            return Task.FromResult<IdempotencyRecord?>(null);
        }
    }

    /// <summary>A pending record is reclaimable once its lease elapses; a completed one once it fully expires.</summary>
    private static bool IsReclaimable(IdempotencyRecord record, DateTimeOffset now) =>
        record.State == IdempotencyState.Pending ? record.LeaseExpiresAt <= now : record.ExpiresAt <= now;

    private void PruneExpired(DateTimeOffset now)
    {
        if (_byScope.Count < 1024)
        {
            return;
        }

        foreach (var key in _byScope.Where(kv => IsReclaimable(kv.Value, now)).Select(kv => kv.Key).ToList())
        {
            _byScope.Remove(key);
        }
    }

    private static IdempotencyRecord Copy(IdempotencyRecord r) => new()
    {
        Scope = r.Scope,
        Fingerprint = r.Fingerprint,
        State = r.State,
        ResponseJson = r.ResponseJson,
        StatusCode = r.StatusCode,
        Location = r.Location,
        CreatedAt = r.CreatedAt,
        LeaseExpiresAt = r.LeaseExpiresAt,
        ExpiresAt = r.ExpiresAt,
    };
}
