using System.Net;
using System.Text.Json.Serialization;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Configuration;

namespace WorldMap.Infrastructure.Cosmos;

/// <summary>
/// Cosmos-backed single-writer lease over one lock document (id = PK = <c>world-writer</c>) in the
/// <c>lock</c> container. Acquire/renew/takeover are ETag compare-and-set: a create wins an unheld
/// lease; an <c>IfMatchEtag</c> replace renews our own or takes over an expired one; a live different
/// holder is rejected. The lock doc itself carries no destructive TTL.
/// </summary>
public sealed class CosmosWriterLeaseStore : IWriterLeaseStore
{
    private const string LockId = "world-writer";
    private const int MaxAttempts = 4;

    private readonly Container _container;

    public CosmosWriterLeaseStore(CosmosClient client, IOptions<WorldMapOptions> options)
    {
        ArgumentNullException.ThrowIfNull(client);
        ArgumentNullException.ThrowIfNull(options);
        _container = client.GetContainer(options.Value.Storage.DatabaseName, CosmosContainers.Lock);
    }

    public async Task<bool> TryAcquireOrRenewAsync(string instanceId, DateTimeOffset now, TimeSpan leaseDuration, CancellationToken ct)
    {
        var pk = new PartitionKey(LockId);
        var nowEpoch = now.ToUnixTimeSeconds();
        var expiresEpoch = now.Add(leaseDuration).ToUnixTimeSeconds();

        for (var attempt = 0; attempt < MaxAttempts; attempt++)
        {
            var existing = await ReadAsync(pk, ct).ConfigureAwait(false);

            if (existing is null)
            {
                try
                {
                    await _container.CreateItemAsync(
                        CosmosDoc.Create(LockId, LockId, new WriterLeaseDoc(instanceId, expiresEpoch)),
                        pk, cancellationToken: ct).ConfigureAwait(false);
                    return true;
                }
                catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.Conflict)
                {
                    continue; // Another instance created it first — re-evaluate.
                }
            }

            var heldByOther = existing.Payload.Holder != instanceId && existing.Payload.ExpiresEpoch > nowEpoch;
            if (heldByOther)
            {
                return false;
            }

            existing.Payload.Holder = instanceId;
            existing.Payload.ExpiresEpoch = expiresEpoch;
            try
            {
                var options = new ItemRequestOptions { IfMatchEtag = existing.Etag };
                await _container.ReplaceItemAsync(existing, LockId, pk, options, ct).ConfigureAwait(false);
                return true;
            }
            catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.PreconditionFailed)
            {
                // Lost the race for the lock doc — re-read and re-evaluate.
            }
        }

        return false;
    }

    public async Task ReleaseAsync(string instanceId, DateTimeOffset now, CancellationToken ct)
    {
        var pk = new PartitionKey(LockId);
        var existing = await ReadAsync(pk, ct).ConfigureAwait(false);
        if (existing is null || existing.Payload.Holder != instanceId)
        {
            return;
        }

        // Expire the lease immediately so a peer can take over without waiting the full duration.
        existing.Payload.ExpiresEpoch = now.ToUnixTimeSeconds();
        try
        {
            var options = new ItemRequestOptions { IfMatchEtag = existing.Etag };
            await _container.ReplaceItemAsync(existing, LockId, pk, options, ct).ConfigureAwait(false);
        }
        catch (CosmosException ex) when (ex.StatusCode is HttpStatusCode.PreconditionFailed or HttpStatusCode.NotFound)
        {
            // Someone else already advanced/took the lock — nothing to release.
        }
    }

    private async Task<CosmosDoc<WriterLeaseDoc>?> ReadAsync(PartitionKey pk, CancellationToken ct)
    {
        try
        {
            var response = await _container.ReadItemAsync<CosmosDoc<WriterLeaseDoc>>(LockId, pk, cancellationToken: ct)
                .ConfigureAwait(false);
            return response.Resource;
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }
    }

    private sealed class WriterLeaseDoc(string holder, long expiresEpoch)
    {
        [JsonPropertyName("holder")]
        public string Holder { get; set; } = holder;

        [JsonPropertyName("expiresEpoch")]
        public long ExpiresEpoch { get; set; } = expiresEpoch;
    }
}
