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

        for (var attempt = 0; attempt < MaxAttempts; attempt++)
        {
            var record = new IdempotencyRecord
            {
                Scope = scope,
                Fingerprint = fingerprint,
                State = IdempotencyState.Pending,
                CreatedAt = now,
                LeaseExpiresAt = now.AddSeconds(IdempotencyRecord.PendingLeaseSeconds),
                ExpiresAt = expiresAt,
            };

            try
            {
                var created = await _container.CreateItemAsync(ToDoc(id, scope, record, now), pk, cancellationToken: ct)
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

                if (ReclaimEpoch(existing.Payload) <= now.ToUnixTimeSeconds())
                {
                    // Pending lease elapsed (or completed record fully expired): reclaim as a fresh
                    // pending claim (won) — atomically, so exactly one caller takes over.
                    try
                    {
                        var replaceOptions = new ItemRequestOptions { IfMatchEtag = existing.Etag };
                        var reclaimed = await _container.ReplaceItemAsync(
                            ToDoc(id, scope, record, now), id, pk, replaceOptions, ct).ConfigureAwait(false);
                        return new IdempotencyClaim(IdempotencyClaimOutcome.Won, reclaimed.Resource.Payload);
                    }
                    catch (CosmosException replaceEx) when (replaceEx.StatusCode == HttpStatusCode.PreconditionFailed)
                    {
                        continue; // Another claimant reclaimed first — re-evaluate.
                    }
                }

                if (existing.Payload.Fingerprint != fingerprint)
                {
                    return new IdempotencyClaim(IdempotencyClaimOutcome.FingerprintConflict, existing.Payload);
                }

                var outcome = existing.Payload.State == IdempotencyState.Completed
                    ? IdempotencyClaimOutcome.Completed
                    : IdempotencyClaimOutcome.AlreadyPending;
                return new IdempotencyClaim(outcome, existing.Payload);
            }
        }

        // Exhausted retries under contention: report the current authoritative state.
        var latest = await ReadDocAsync(id, pk, ct).ConfigureAwait(false);
        if (latest is null)
        {
            var record = new IdempotencyRecord
            {
                Scope = scope,
                Fingerprint = fingerprint,
                State = IdempotencyState.Pending,
                CreatedAt = now,
                LeaseExpiresAt = now.AddSeconds(IdempotencyRecord.PendingLeaseSeconds),
                ExpiresAt = expiresAt,
            };
            return new IdempotencyClaim(IdempotencyClaimOutcome.AlreadyPending, record);
        }

        var finalOutcome = latest.Payload.Fingerprint != fingerprint
            ? IdempotencyClaimOutcome.FingerprintConflict
            : latest.Payload.State == IdempotencyState.Completed
                ? IdempotencyClaimOutcome.Completed
                : IdempotencyClaimOutcome.AlreadyPending;
        return new IdempotencyClaim(finalOutcome, latest.Payload);
    }

    public async Task CompleteAsync(
        string scope, string fingerprint, string responseJson, int statusCode, string? location, DateTimeOffset now, CancellationToken ct)
    {
        var id = CosmosId.Hash(scope);
        var pk = new PartitionKey(scope);

        for (var attempt = 0; attempt < MaxAttempts; attempt++)
        {
            var existing = await ReadDocAsync(id, pk, ct).ConfigureAwait(false);
            if (existing is null || existing.Payload.Fingerprint != fingerprint)
            {
                return; // Nothing owned to complete (mirrors the in-memory reference).
            }

            existing.Payload.State = IdempotencyState.Completed;
            existing.Payload.ResponseJson = responseJson;
            existing.Payload.StatusCode = statusCode;
            existing.Payload.Location = location;
            // A completed record is replayable until its full expiry (not the short pending lease).
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

    public async Task ReleaseAsync(string scope, string fingerprint, CancellationToken ct)
    {
        var id = CosmosId.Hash(scope);
        var pk = new PartitionKey(scope);

        for (var attempt = 0; attempt < MaxAttempts; attempt++)
        {
            var existing = await ReadDocAsync(id, pk, ct).ConfigureAwait(false);
            if (existing is null
                || existing.Payload.State != IdempotencyState.Pending
                || existing.Payload.Fingerprint != fingerprint)
            {
                return; // Nothing owned to release.
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

        return ReclaimEpoch(existing.Payload) > clock.GetUtcNow().ToUnixTimeSeconds() ? existing.Payload : null; // Reclaimable ⇒ absent.
    }

    /// <summary>The epoch after which a record is reclaimable: the pending lease, or the completed final expiry.</summary>
    private static long ReclaimEpoch(IdempotencyRecord record) =>
        record.State == IdempotencyState.Pending
            ? record.LeaseExpiresAt.ToUnixTimeSeconds()
            : record.ExpiresAt.ToUnixTimeSeconds();

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
        // Pending docs live for the lease; completed docs are extended to their full expiry on Complete.
        var reclaimEpoch = ReclaimEpoch(record);
        var ttlSeconds = (int)Math.Max(1, reclaimEpoch - now.ToUnixTimeSeconds());
        return CosmosDoc.Create(id, scope, record, ttl: ttlSeconds, expiresAtEpoch: reclaimEpoch);
    }
}
