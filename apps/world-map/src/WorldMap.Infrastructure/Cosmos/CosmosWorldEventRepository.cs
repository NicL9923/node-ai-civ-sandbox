using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Configuration;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.Cosmos;

/// <summary>
/// Cosmos-backed public world-event ledger. All events live in a single logical partition
/// (<see cref="CosmosContainers.WorldEventFeedPartition"/>) to preserve global ordering for the
/// MVP feed/SSE — a deliberate hot-partition tradeoff documented on that constant.
/// </summary>
public sealed class CosmosWorldEventRepository(CosmosClient client, IOptions<WorldMapOptions> options)
    : IWorldEventRepository
{
    private static readonly PartitionKey FeedPartition = new(CosmosContainers.WorldEventFeedPartition);

    private readonly Container _container =
        client.GetContainer(options.Value.Storage.DatabaseName, CosmosContainers.WorldEvents);

    public async Task AddAsync(WorldEvent worldEvent, CancellationToken ct)
    {
        var doc = CosmosDoc.Create(
            worldEvent.EventId, CosmosContainers.WorldEventFeedPartition, worldEvent);
        await _container.CreateItemAsync(doc, FeedPartition, cancellationToken: ct);
    }

    public async Task<WorldEvent?> GetByDedupeAsync(string dedupeKey, CancellationToken ct)
    {
        var query = new QueryDefinition(
                "SELECT * FROM c WHERE c.payload.dedupeKey = @dedupeKey OFFSET 0 LIMIT 1")
            .WithParameter("@dedupeKey", dedupeKey);
        var requestOptions = new QueryRequestOptions { PartitionKey = FeedPartition };

        using var iterator = _container.GetItemQueryIterator<CosmosDoc<WorldEvent>>(query, requestOptions: requestOptions);
        while (iterator.HasMoreResults)
        {
            foreach (var doc in await iterator.ReadNextAsync(ct))
            {
                return doc.Payload;
            }
        }

        return null;
    }

    public async Task<Page<WorldEvent>> ListAsync(long afterSequence, int limit, CancellationToken ct)
    {
        var query = new QueryDefinition(
                "SELECT * FROM c WHERE c.payload.worldsequence > @after ORDER BY c.payload.worldsequence ASC OFFSET 0 LIMIT @limit")
            .WithParameter("@after", afterSequence)
            .WithParameter("@limit", limit);
        var requestOptions = new QueryRequestOptions { PartitionKey = FeedPartition };

        var items = new List<WorldEvent>();
        using var iterator = _container.GetItemQueryIterator<CosmosDoc<WorldEvent>>(query, requestOptions: requestOptions);
        while (iterator.HasMoreResults)
        {
            foreach (var doc in await iterator.ReadNextAsync(ct))
            {
                items.Add(doc.Payload);
            }
        }

        long? next = limit > 0 && items.Count == limit ? items[^1].Worldsequence : null;
        return new Page<WorldEvent>(items, next);
    }
}
