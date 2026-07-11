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

            // The scope is free only when there is no record, or the record has fully expired (its
            // idempotency TTL elapsed). Lease expiry alone does NOT free the scope.
            if (!_byScope.TryGetValue(scope, out var existing) || existing.ExpiresAt <= now)
            {
                _byScope[scope] = NewPending(scope, fingerprint, now, expiresAt);
                return Task.FromResult(new IdempotencyClaim(IdempotencyClaimOutcome.Won, Copy(_byScope[scope])));
            }

            // A different fingerprint on a live (non-expired) record is ALWAYS a hard conflict,
            // regardless of the pending lease state — checked before any reclaim.
            if (existing.Fingerprint != fingerprint)
            {
                return Task.FromResult(new IdempotencyClaim(IdempotencyClaimOutcome.FingerprintConflict, Copy(existing)));
            }

            if (existing.State == IdempotencyState.Completed)
            {
                return Task.FromResult(new IdempotencyClaim(IdempotencyClaimOutcome.Completed, Copy(existing)));
            }

            // Pending, same fingerprint: reclaim only once the owner's lease has elapsed. Preserve the
            // record and its ExpiresAt; issue a fresh lease token so the prior owner can no longer
            // Complete/Release.
            if (existing.LeaseExpiresAt <= now)
            {
                existing.LeaseToken = NewToken();
                existing.LeaseExpiresAt = now.Add(PendingLease);
                return Task.FromResult(new IdempotencyClaim(IdempotencyClaimOutcome.Won, Copy(existing)));
            }

            return Task.FromResult(new IdempotencyClaim(IdempotencyClaimOutcome.AlreadyPending, Copy(existing)));
        }
    }

    public Task CompleteAsync(string scope, string fingerprint, string leaseToken, string responseJson, int statusCode, string? location, DateTimeOffset now, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            if (_byScope.TryGetValue(scope, out var existing)
                && existing.State == IdempotencyState.Pending
                && existing.Fingerprint == fingerprint
                && existing.LeaseToken == leaseToken)
            {
                existing.State = IdempotencyState.Completed;
                existing.ResponseJson = responseJson;
                existing.StatusCode = statusCode;
                existing.Location = location;
            }
        }

        return Task.CompletedTask;
    }

    public Task ReleaseAsync(string scope, string fingerprint, string leaseToken, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            if (_byScope.TryGetValue(scope, out var existing)
                && existing.State == IdempotencyState.Pending
                && existing.Fingerprint == fingerprint
                && existing.LeaseToken == leaseToken)
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
            if (_byScope.TryGetValue(scope, out var record) && record.ExpiresAt > now)
            {
                return Task.FromResult<IdempotencyRecord?>(Copy(record));
            }

            return Task.FromResult<IdempotencyRecord?>(null);
        }
    }

    private static IdempotencyRecord NewPending(string scope, string fingerprint, DateTimeOffset now, DateTimeOffset expiresAt) => new()
    {
        Scope = scope,
        Fingerprint = fingerprint,
        State = IdempotencyState.Pending,
        LeaseToken = NewToken(),
        CreatedAt = now,
        LeaseExpiresAt = now.Add(PendingLease),
        ExpiresAt = expiresAt,
    };

    private static string NewToken() => Guid.NewGuid().ToString("N");

    private void PruneExpired(DateTimeOffset now)
    {
        if (_byScope.Count < 1024)
        {
            return;
        }

        foreach (var key in _byScope.Where(kv => kv.Value.ExpiresAt <= now).Select(kv => kv.Key).ToList())
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
        LeaseToken = r.LeaseToken,
        CreatedAt = r.CreatedAt,
        LeaseExpiresAt = r.LeaseExpiresAt,
        ExpiresAt = r.ExpiresAt,
    };
}
