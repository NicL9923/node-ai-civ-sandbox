using System.Net;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Configuration;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.Cosmos;

/// <summary>
/// Cosmos-backed civilization registry (partition = <c>civId</c>). Uses optimistic concurrency:
/// when the aggregate carries an <see cref="Civilization.Etag"/> the upsert is guarded with
/// <c>If-Match</c> and a 412 surfaces as an <see cref="InvalidOperationException"/>.
/// </summary>
public sealed class CosmosCivilizationRepository(CosmosClient client, IOptions<WorldMapOptions> options)
    : ICivilizationRepository
{
    private readonly Container _container =
        client.GetContainer(options.Value.Storage.DatabaseName, CosmosContainers.Civilizations);

    public async Task<Civilization?> GetAsync(string civId, CancellationToken ct)
    {
        try
        {
            var response = await _container.ReadItemAsync<CosmosDoc<Civilization>>(
                civId, new PartitionKey(civId), cancellationToken: ct);
            return Hydrate(response.Resource);
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }
    }

    public async Task<Page<Civilization>> ListAsync(long afterOrdinal, int limit, CancellationToken ct)
    {
        var query = new QueryDefinition(
                "SELECT * FROM c WHERE c.payload.ordinal > @after ORDER BY c.payload.ordinal ASC OFFSET 0 LIMIT @limit")
            .WithParameter("@after", afterOrdinal)
            .WithParameter("@limit", limit);

        var items = await RunQueryAsync(query, ct);
        long? next = limit > 0 && items.Count == limit ? items[^1].Ordinal : null;
        return new Page<Civilization>(items, next);
    }

    public async Task UpsertAsync(Civilization civilization, CancellationToken ct)
    {
        var doc = CosmosDoc.Create(civilization.CivId, civilization.CivId, civilization);
        var requestOptions = civilization.Etag is { Length: > 0 } etag
            ? new ItemRequestOptions { IfMatchEtag = etag }
            : null;

        try
        {
            var response = await _container.UpsertItemAsync(
                doc, new PartitionKey(civilization.CivId), requestOptions, ct);
            civilization.Etag = response.ETag;
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.PreconditionFailed)
        {
            // TODO: promote to a typed concurrency-conflict result once repositories return Result<T>.
            throw new InvalidOperationException(
                $"Concurrency conflict upserting civilization '{civilization.CivId}'.", ex);
        }
    }

    public async Task<IReadOnlyList<Civilization>> ListAllAsync(CancellationToken ct)
        => await RunQueryAsync(new QueryDefinition("SELECT * FROM c"), ct);

    private async Task<List<Civilization>> RunQueryAsync(QueryDefinition query, CancellationToken ct)
    {
        var results = new List<Civilization>();
        using var iterator = _container.GetItemQueryIterator<CosmosDoc<Civilization>>(query);
        while (iterator.HasMoreResults)
        {
            foreach (var doc in await iterator.ReadNextAsync(ct))
            {
                results.Add(Hydrate(doc));
            }
        }

        return results;
    }

    private static Civilization Hydrate(CosmosDoc<Civilization> doc)
    {
        var civ = doc.Payload;
        civ.Etag = doc.Etag;
        return civ;
    }
}
