using System.Net;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Configuration;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.Cosmos;

/// <summary>
/// Cosmos-backed relationship projections (doc id = PK = <c>PairKey</c>).
///
/// <para><b>Ordinal.</b> Assigned exactly once at first insert via a
/// <see cref="CosmosSequenceAllocator"/> (allocate-through-insert), keeping list pagination stable.</para>
///
/// <para><b>CAS upsert.</b> <see cref="TryUpsertAsync"/> is a monotonic-version compare-and-set:
/// against an existing projection it rejects a stale write (stored version already at/ahead of the
/// incoming version) and otherwise <c>Replace</c>s with <c>IfMatchEtag</c>, returning <c>false</c>
/// on a 412 so the caller reloads and retries. First insert races resolve create-conflict → false
/// (reload, then take the version-CAS path).</para>
/// </summary>
public sealed class CosmosRelationshipRepository : IRelationshipRepository
{
    private readonly Container _container;
    private readonly CosmosSequenceAllocator _ordinals;

    public CosmosRelationshipRepository(CosmosClient client, IOptions<WorldMapOptions> options)
    {
        ArgumentNullException.ThrowIfNull(client);
        ArgumentNullException.ThrowIfNull(options);
        var database = options.Value.Storage.DatabaseName;
        _container = client.GetContainer(database, CosmosContainers.Relationships);
        var counters = client.GetContainer(database, CosmosContainers.Sequences);
        _ordinals = new CosmosSequenceAllocator(counters, "relationship:ordinal");
    }

    public async Task<Relationship?> GetAsync(string pairKey, CancellationToken ct)
    {
        var doc = await ReadDocAsync(pairKey, ct).ConfigureAwait(false);
        return doc is null ? null : Hydrate(doc);
    }

    public async Task<Page<Relationship>> ListAsync(long afterOrdinal, int limit, CancellationToken ct)
    {
        var query = new QueryDefinition(
                "SELECT * FROM c WHERE c.payload.ordinal > @after ORDER BY c.payload.ordinal ASC OFFSET 0 LIMIT @limit")
            .WithParameter("@after", afterOrdinal)
            .WithParameter("@limit", limit);

        var items = new List<Relationship>();
        using var iterator = _container.GetItemQueryIterator<CosmosDoc<Relationship>>(query);
        while (iterator.HasMoreResults)
        {
            foreach (var doc in await iterator.ReadNextAsync(ct).ConfigureAwait(false))
            {
                items.Add(Hydrate(doc));
            }
        }

        long? next = limit > 0 && items.Count == limit ? items[^1].Ordinal : null;
        return new Page<Relationship>(items, next);
    }

    public async Task<bool> TryUpsertAsync(Relationship relationship, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(relationship);

        var stored = await ReadDocAsync(relationship.PairKey, ct).ConfigureAwait(false);
        if (stored is not null)
        {
            if (stored.Payload.Version >= relationship.Version)
            {
                return false; // Stale write.
            }

            relationship.Ordinal = stored.Payload.Ordinal; // Ordinal fixed at first insert.
            try
            {
                var options = new ItemRequestOptions { IfMatchEtag = stored.Etag };
                var response = await _container.ReplaceItemAsync(
                    CosmosDoc.Create(relationship.PairKey, relationship.PairKey, relationship),
                    relationship.PairKey, new PartitionKey(relationship.PairKey), options, ct).ConfigureAwait(false);
                relationship.Etag = response.ETag;
                return true;
            }
            catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.PreconditionFailed)
            {
                return false; // Concurrent writer won — caller reloads and retries.
            }
        }

        return await _ordinals.AllocateAsync(
            MaxOrdinalAsync,
            async (next, token) =>
            {
                relationship.Ordinal = next;
                try
                {
                    var created = await _container.CreateItemAsync(
                        CosmosDoc.Create(relationship.PairKey, relationship.PairKey, relationship),
                        new PartitionKey(relationship.PairKey), cancellationToken: token).ConfigureAwait(false);
                    relationship.Etag = created.ETag;
                    return new SequenceInsert<bool>(true, true);
                }
                catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.Conflict)
                {
                    // Lost the first-insert race: release the ordinal; caller reloads and retries via CAS.
                    return new SequenceInsert<bool>(false, false);
                }
            },
            ct).ConfigureAwait(false);
    }

    private async Task<CosmosDoc<Relationship>?> ReadDocAsync(string pairKey, CancellationToken ct)
    {
        try
        {
            var response = await _container.ReadItemAsync<CosmosDoc<Relationship>>(
                pairKey, new PartitionKey(pairKey), cancellationToken: ct).ConfigureAwait(false);
            return response.Resource;
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }
    }

    private async Task<long> MaxOrdinalAsync(CancellationToken ct)
    {
        using var iterator = _container.GetItemQueryIterator<long?>(
            new QueryDefinition("SELECT VALUE MAX(c.payload.ordinal) FROM c"));
        long max = 0;
        while (iterator.HasMoreResults)
        {
            foreach (var value in await iterator.ReadNextAsync(ct).ConfigureAwait(false))
            {
                if (value is { } v && v > max)
                {
                    max = v;
                }
            }
        }

        return max;
    }

    private static Relationship Hydrate(CosmosDoc<Relationship> doc)
    {
        var relationship = doc.Payload;
        relationship.Etag = doc.Etag;
        return relationship;
    }
}
