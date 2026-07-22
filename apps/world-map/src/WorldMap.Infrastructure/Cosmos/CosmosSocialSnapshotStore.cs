using System.Net;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Configuration;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.Cosmos;

/// <summary>
/// Cosmos-backed durable following-feed snapshots (doc id = <c>SnapshotId</c>; PK = <c>OwnerAccountId</c>).
/// <see cref="UpsertAsync"/> is a create-if-absent (idempotent by the deterministic snapshot id): a
/// create-conflict means the snapshot was already frozen and is swallowed. A per-item TTL derived from
/// <see cref="SocialSnapshot.ExpiresAt"/> self-purges the record on the TTL-enabled container. A by-id
/// read is cross-partition (snapshots partition by owner, not by snapshot id).
/// </summary>
public sealed class CosmosSocialSnapshotStore : ISocialSnapshotStore
{
    private readonly Container _container;

    public CosmosSocialSnapshotStore(CosmosClient client, IOptions<WorldMapOptions> options)
    {
        ArgumentNullException.ThrowIfNull(client);
        ArgumentNullException.ThrowIfNull(options);
        _container = client.GetContainer(options.Value.Storage.DatabaseName, CosmosContainers.SocialSnapshots);
    }

    public async Task<SocialSnapshot?> GetAsync(string snapshotId, CancellationToken ct)
    {
        // Snapshots partition by owner, so a point read by id alone is cross-partition.
        var query = new QueryDefinition("SELECT * FROM c WHERE c.id = @id").WithParameter("@id", snapshotId);
        using var iterator = _container.GetItemQueryIterator<CosmosDoc<SocialSnapshot>>(query);
        while (iterator.HasMoreResults)
        {
            foreach (var doc in await iterator.ReadNextAsync(ct).ConfigureAwait(false))
            {
                return doc.Payload;
            }
        }

        return null;
    }

    public async Task UpsertAsync(SocialSnapshot snapshot, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        var expiresEpoch = snapshot.ExpiresAt.ToUnixTimeSeconds();
        var ttl = (int)Math.Max(1, Math.Ceiling((snapshot.ExpiresAt - DateTimeOffset.UtcNow).TotalSeconds));
        var doc = CosmosDoc.Create(
            snapshot.SnapshotId, snapshot.OwnerAccountId, snapshot, ttl: ttl, expiresAtEpoch: expiresEpoch);
        try
        {
            await _container.CreateItemAsync(
                doc, new PartitionKey(snapshot.OwnerAccountId), cancellationToken: ct).ConfigureAwait(false);
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.Conflict)
        {
            // Already frozen (idempotent create) — nothing to do.
        }
    }
}
