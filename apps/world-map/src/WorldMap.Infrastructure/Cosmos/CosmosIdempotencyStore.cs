using System.Net;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Configuration;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.Cosmos;

/// <summary>
/// Cosmos-backed idempotency store with the claim/complete lifecycle (doc id = SHA-256 of the scope,
/// PK = scope). A per-item <c>ttl</c> on the TTL-enabled container self-purges records; the promoted
/// top-level <c>expiresAtEpoch</c> (UTC seconds) makes "expired" comparisons numeric and offset-safe
/// so an expired record is treated as absent (reclaimable) even before the TTL sweep runs.
///
/// <para><see cref="ClaimAsync"/> try-creates a pending doc (create-conflict → inspect existing:
/// expired ⇒ reclaim as a fresh <c>Won</c> pending claim; fingerprint mismatch ⇒ conflict; completed
/// ⇒ replay; else already-pending). <see cref="CompleteAsync"/> transitions an owned pending claim to
/// completed only when the fingerprint matches, via an <c>IfMatchEtag</c> replace.</para>
/// </summary>
public sealed class CosmosIdempotencyStore(CosmosClient client, IOptions<WorldMapOptions> options, TimeProvider clock)
    : IIdempotencyStore
{
    private const int MaxAttempts = 5;

    private readonly Container _container =
        client.GetContainer(options.Value.Storage.DatabaseName, CosmosContainers.Idempotency);

    public async Task<IdempotencyClaim> ClaimAsync(
        string scope, string fingerprint, DateTimeOffset now, DateTimeOffset expiresAt, CancellationToken ct)
    {
        var id = CosmosId.Hash(scope);
        var pk = new PartitionKey(scope);
        var nowEpoch = now.ToUnixTimeSeconds();

        for (var attempt = 0; attempt < MaxAttempts; attempt++)
        {
            var fresh = NewPending(scope, fingerprint, now, expiresAt);

            try
            {
                var created = await _container.CreateItemAsync(ToDoc(id, scope, fresh, now), pk, cancellationToken: ct)
                    .ConfigureAwait(false);
                return new IdempotencyClaim(IdempotencyClaimOutcome.Won, created.Resource.Payload);
            }
            catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.Conflict)
            {
                var existing = await ReadDocAsync(id, pk, ct).ConfigureAwait(false);
                if (existing is null)
                {
                    continue; // Raced with a TTL purge — retry the create.
                }

                // The scope is free only when the record has fully expired (idempotency TTL elapsed),
                // not merely when a pending lease elapsed. A fully expired record can be reclaimed by
                // ANY fingerprint as a brand-new claim.
                if (existing.Payload.ExpiresAt.ToUnixTimeSeconds() <= nowEpoch)
                {
                    if (await TryReplaceAsync(id, scope, pk, fresh, now, existing.Etag, ct).ConfigureAwait(false) is { } won)
                    {
                        return new IdempotencyClaim(IdempotencyClaimOutcome.Won, won);
                    }

                    continue; // Another claimant reclaimed first — re-evaluate.
                }

                // Live record: a different fingerprint is ALWAYS a conflict, checked before any reclaim.
                if (existing.Payload.Fingerprint != fingerprint)
                {
                    return new IdempotencyClaim(IdempotencyClaimOutcome.FingerprintConflict, existing.Payload);
                }

                if (existing.Payload.State == IdempotencyState.Completed)
                {
                    return new IdempotencyClaim(IdempotencyClaimOutcome.Completed, existing.Payload);
                }

                // Pending, same fingerprint: reclaim only once the owner's lease elapsed. Preserve the
                // record's ExpiresAt/CreatedAt/Fingerprint; issue a fresh lease token.
                if (existing.Payload.LeaseExpiresAt.ToUnixTimeSeconds() <= nowEpoch)
                {
                    var reclaim = Reclaim(existing.Payload, now);
                    if (await TryReplaceAsync(id, scope, pk, reclaim, now, existing.Etag, ct).ConfigureAwait(false) is { } took)
                    {
                        return new IdempotencyClaim(IdempotencyClaimOutcome.Won, took);
                    }

                    continue;
                }

                return new IdempotencyClaim(IdempotencyClaimOutcome.AlreadyPending, existing.Payload);
            }
        }

        // Exhausted retries under contention: report the current authoritative state.
        var latest = await ReadDocAsync(id, pk, ct).ConfigureAwait(false);
        if (latest is null || latest.Payload.ExpiresAt.ToUnixTimeSeconds() <= nowEpoch)
        {
            return new IdempotencyClaim(IdempotencyClaimOutcome.AlreadyPending, NewPending(scope, fingerprint, now, expiresAt));
        }

        var finalOutcome = latest.Payload.Fingerprint != fingerprint
            ? IdempotencyClaimOutcome.FingerprintConflict
            : latest.Payload.State == IdempotencyState.Completed
                ? IdempotencyClaimOutcome.Completed
                : IdempotencyClaimOutcome.AlreadyPending;
        return new IdempotencyClaim(finalOutcome, latest.Payload);
    }

    private async Task<IdempotencyRecord?> TryReplaceAsync(
        string id, string scope, PartitionKey pk, IdempotencyRecord record, DateTimeOffset now, string? etag, CancellationToken ct)
    {
        try
        {
            var options = new ItemRequestOptions { IfMatchEtag = etag };
            var replaced = await _container.ReplaceItemAsync(ToDoc(id, scope, record, now), id, pk, options, ct).ConfigureAwait(false);
            return replaced.Resource.Payload;
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.PreconditionFailed)
        {
            return null;
        }
    }

    public async Task CompleteAsync(
        string scope, string fingerprint, string leaseToken, string responseJson, int statusCode, string? location, DateTimeOffset now, CancellationToken ct)
    {
        var id = CosmosId.Hash(scope);
        var pk = new PartitionKey(scope);

        for (var attempt = 0; attempt < MaxAttempts; attempt++)
        {
            var existing = await ReadDocAsync(id, pk, ct).ConfigureAwait(false);
            if (existing is null
                || existing.Payload.State != IdempotencyState.Pending
                || existing.Payload.Fingerprint != fingerprint
                || existing.Payload.LeaseToken != leaseToken)
            {
                return; // Nothing this owner may complete (mirrors the in-memory reference).
            }

            existing.Payload.State = IdempotencyState.Completed;
            existing.Payload.ResponseJson = responseJson;
            existing.Payload.StatusCode = statusCode;
            existing.Payload.Location = location;
            // A completed record is replayable until its full expiry (which the pending doc already had).
            existing.ExpiresAtEpoch = existing.Payload.ExpiresAt.ToUnixTimeSeconds();
            existing.Ttl = (int)Math.Max(1, Math.Ceiling((existing.Payload.ExpiresAt - now).TotalSeconds));

            try
            {
                var options = new ItemRequestOptions { IfMatchEtag = existing.Etag };
                await _container.ReplaceItemAsync(existing, id, pk, options, ct).ConfigureAwait(false);
                return;
            }
            catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.PreconditionFailed)
            {
                // Retry against the newest revision.
            }
        }
    }

    public async Task ReleaseAsync(string scope, string fingerprint, string leaseToken, CancellationToken ct)
    {
        var id = CosmosId.Hash(scope);
        var pk = new PartitionKey(scope);

        for (var attempt = 0; attempt < MaxAttempts; attempt++)
        {
            var existing = await ReadDocAsync(id, pk, ct).ConfigureAwait(false);
            if (existing is null
                || existing.Payload.State != IdempotencyState.Pending
                || existing.Payload.Fingerprint != fingerprint
                || existing.Payload.LeaseToken != leaseToken)
            {
                return; // Nothing this owner may release.
            }

            try
            {
                var options = new ItemRequestOptions { IfMatchEtag = existing.Etag };
                await _container.DeleteItemAsync<CosmosDoc<IdempotencyRecord>>(id, pk, options, ct).ConfigureAwait(false);
                return;
            }
            catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.PreconditionFailed)
            {
                // Someone else advanced the record; re-evaluate.
            }
            catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
            {
                return;
            }
        }
    }

    public async Task<IdempotencyRecord?> GetAsync(string scope, CancellationToken ct)
    {
        var existing = await ReadDocAsync(CosmosId.Hash(scope), new PartitionKey(scope), ct).ConfigureAwait(false);
        if (existing is null)
        {
            return null;
        }

        // Fully-expired records are treated as absent (a completed response is replayable until then).
        return existing.Payload.ExpiresAt.ToUnixTimeSeconds() > clock.GetUtcNow().ToUnixTimeSeconds() ? existing.Payload : null;
    }

    private static IdempotencyRecord NewPending(string scope, string fingerprint, DateTimeOffset now, DateTimeOffset expiresAt) => new()
    {
        Scope = scope,
        Fingerprint = fingerprint,
        State = IdempotencyState.Pending,
        LeaseToken = Guid.NewGuid().ToString("N"),
        CreatedAt = now,
        LeaseExpiresAt = now.AddSeconds(IdempotencyRecord.PendingLeaseSeconds),
        ExpiresAt = expiresAt,
    };

    /// <summary>A fresh pending lease over the SAME logical claim (preserves fingerprint + full expiry).</summary>
    private static IdempotencyRecord Reclaim(IdempotencyRecord existing, DateTimeOffset now) => new()
    {
        Scope = existing.Scope,
        Fingerprint = existing.Fingerprint,
        State = IdempotencyState.Pending,
        LeaseToken = Guid.NewGuid().ToString("N"),
        CreatedAt = existing.CreatedAt,
        LeaseExpiresAt = now.AddSeconds(IdempotencyRecord.PendingLeaseSeconds),
        ExpiresAt = existing.ExpiresAt,
    };

    private async Task<CosmosDoc<IdempotencyRecord>?> ReadDocAsync(string id, PartitionKey pk, CancellationToken ct)
    {
        try
        {
            var response = await _container.ReadItemAsync<CosmosDoc<IdempotencyRecord>>(id, pk, cancellationToken: ct)
                .ConfigureAwait(false);
            return response.Resource;
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }
    }

    private static CosmosDoc<IdempotencyRecord> ToDoc(string id, string scope, IdempotencyRecord record, DateTimeOffset now)
    {
        // Both pending and completed docs live for the full idempotency TTL (ExpiresAt), so lease
        // expiry never deletes the record and the fingerprint-conflict guard survives the whole TTL.
        var expiresEpoch = record.ExpiresAt.ToUnixTimeSeconds();
        var ttlSeconds = (int)Math.Max(1, expiresEpoch - now.ToUnixTimeSeconds());
        return CosmosDoc.Create(id, scope, record, ttl: ttlSeconds, expiresAtEpoch: expiresEpoch);
    }
}
