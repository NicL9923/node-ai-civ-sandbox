using System.Net;
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
///
/// <para><b>Doc id / PK.</b> id = SHA-256 of the producer-scoped <c>DedupeKey</c> (so a duplicate
/// append is a create-conflict); PK = the constant <c>"public"</c> feed partition.</para>
///
/// <para><b>Atomic <c>Worldsequence</c>.</b> Assigned by <see cref="CosmosSequenceAllocator"/>:
/// allocation and insert are serialized so the read cursor never advances past an uncommitted
/// record. Dedupe is checked before allocation (and on the create-conflict race) so a duplicate
/// never consumes a sequence number.</para>
/// </summary>
public sealed class CosmosWorldEventRepository : IWorldEventRepository
{
    private static readonly PartitionKey FeedPartition = new(CosmosContainers.WorldEventFeedPartition);

    private readonly Container _container;
    private readonly CosmosSequenceAllocator _sequence;

    public CosmosWorldEventRepository(CosmosClient client, IOptions<WorldMapOptions> options)
    {
        ArgumentNullException.ThrowIfNull(client);
        ArgumentNullException.ThrowIfNull(options);
        var database = options.Value.Storage.DatabaseName;
        _container = client.GetContainer(database, CosmosContainers.WorldEvents);
        var counters = client.GetContainer(database, CosmosContainers.Sequences);
        _sequence = new CosmosSequenceAllocator(counters, "worldevent:worldsequence");
    }

    public async Task<WorldEventAppend> AppendAsync(WorldEvent worldEvent, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(worldEvent);
        var id = CosmosId.Hash(worldEvent.DedupeKey);

        // Fast-path dedupe: an already-committed event returns without consuming a sequence.
        var existing = await ReadByIdAsync(id, ct).ConfigureAwait(false);
        if (existing is not null)
        {
            return new WorldEventAppend(existing, true);
        }

        return await _sequence.AllocateAsync(
            MaxWorldsequenceAsync,
            async (next, token) =>
            {
                worldEvent.Worldsequence = next;
                var doc = CosmosDoc.Create(id, CosmosContainers.WorldEventFeedPartition, worldEvent);
                try
                {
                    var response = await _container.CreateItemAsync(doc, FeedPartition, cancellationToken: token)
                        .ConfigureAwait(false);
                    return new SequenceInsert<WorldEventAppend>(true, new WorldEventAppend(response.Resource.Payload, false));
                }
                catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.Conflict)
                {
                    // A concurrent writer committed the same dedupe key: release the number, return theirs.
                    var duplicate = await ReadByIdAsync(id, token).ConfigureAwait(false) ?? worldEvent;
                    return new SequenceInsert<WorldEventAppend>(false, new WorldEventAppend(duplicate, true));
                }
            },
            ct).ConfigureAwait(false);
    }

    public Task<WorldEvent?> GetByDedupeAsync(string dedupeKey, CancellationToken ct)
        => ReadByIdAsync(CosmosId.Hash(dedupeKey), ct);

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
            foreach (var doc in await iterator.ReadNextAsync(ct).ConfigureAwait(false))
            {
                items.Add(doc.Payload);
            }
        }

        long? next = limit > 0 && items.Count == limit ? items[^1].Worldsequence : null;
        return new Page<WorldEvent>(items, next);
    }

    private async Task<WorldEvent?> ReadByIdAsync(string id, CancellationToken ct)
    {
        try
        {
            var response = await _container.ReadItemAsync<CosmosDoc<WorldEvent>>(id, FeedPartition, cancellationToken: ct)
                .ConfigureAwait(false);
            return response.Resource.Payload;
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }
    }

    private async Task<long> MaxWorldsequenceAsync(CancellationToken ct)
    {
        var query = new QueryDefinition("SELECT VALUE MAX(c.payload.worldsequence) FROM c");
        var requestOptions = new QueryRequestOptions { PartitionKey = FeedPartition };
        using var iterator = _container.GetItemQueryIterator<long?>(query, requestOptions: requestOptions);
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
}
