using System.Net;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Configuration;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.Cosmos;

/// <summary>
/// Cosmos-backed relationship projections (partition = <c>pairKey</c>). Optimistic concurrency
/// mirrors the civilization repository: an <see cref="Relationship.Etag"/> triggers an
/// <c>If-Match</c> upsert and a 412 surfaces as an <see cref="InvalidOperationException"/>.
/// </summary>
public sealed class CosmosRelationshipRepository(CosmosClient client, IOptions<WorldMapOptions> options)
    : IRelationshipRepository
{
    private readonly Container _container =
        client.GetContainer(options.Value.Storage.DatabaseName, CosmosContainers.Relationships);

    public async Task<Relationship?> GetAsync(string pairKey, CancellationToken ct)
    {
        try
        {
            var response = await _container.ReadItemAsync<CosmosDoc<Relationship>>(
                pairKey, new PartitionKey(pairKey), cancellationToken: ct);
            return Hydrate(response.Resource);
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }
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
            foreach (var doc in await iterator.ReadNextAsync(ct))
            {
                items.Add(Hydrate(doc));
            }
        }

        long? next = limit > 0 && items.Count == limit ? items[^1].Ordinal : null;
        return new Page<Relationship>(items, next);
    }

    public async Task UpsertAsync(Relationship relationship, CancellationToken ct)
    {
        var doc = CosmosDoc.Create(relationship.PairKey, relationship.PairKey, relationship);
        var requestOptions = relationship.Etag is { Length: > 0 } etag
            ? new ItemRequestOptions { IfMatchEtag = etag }
            : null;

        try
        {
            var response = await _container.UpsertItemAsync(
                doc, new PartitionKey(relationship.PairKey), requestOptions, ct);
            relationship.Etag = response.ETag;
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.PreconditionFailed)
        {
            // TODO: promote to a typed concurrency-conflict result once repositories return Result<T>.
            throw new InvalidOperationException(
                $"Concurrency conflict upserting relationship '{relationship.PairKey}'.", ex);
        }
    }

    private static Relationship Hydrate(CosmosDoc<Relationship> doc)
    {
        var relationship = doc.Payload;
        relationship.Etag = doc.Etag;
        return relationship;
    }
}
