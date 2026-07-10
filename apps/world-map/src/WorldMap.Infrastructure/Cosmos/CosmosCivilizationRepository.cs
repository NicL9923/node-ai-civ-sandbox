using System.Net;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Configuration;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.Cosmos;

/// <summary>
/// Cosmos-backed civilization registry (doc id = PK = <c>CivId</c>). The World is the sole writer,
/// so <see cref="UpsertAsync"/> is last-writer-wins; the only invariant enforced here is that the
/// stable monotonic <c>Ordinal</c> is assigned exactly once at first insert. First insert routes
/// through a <see cref="CosmosSequenceAllocator"/> (allocate-through-insert) so list pagination
/// never exposes a cursor position past a civ that is not yet persisted.
/// </summary>
public sealed class CosmosCivilizationRepository : ICivilizationRepository
{
    private readonly Container _container;
    private readonly CosmosSequenceAllocator _ordinals;

    public CosmosCivilizationRepository(CosmosClient client, IOptions<WorldMapOptions> options)
    {
        ArgumentNullException.ThrowIfNull(client);
        ArgumentNullException.ThrowIfNull(options);
        var database = options.Value.Storage.DatabaseName;
        _container = client.GetContainer(database, CosmosContainers.Civilizations);
        var counters = client.GetContainer(database, CosmosContainers.Sequences);
        _ordinals = new CosmosSequenceAllocator(counters, "civilization:ordinal");
    }

    public async Task<Civilization?> GetAsync(string civId, CancellationToken ct)
    {
        var doc = await ReadDocAsync(civId, ct).ConfigureAwait(false);
        return doc is null ? null : Hydrate(doc);
    }

    public async Task<Page<Civilization>> ListAsync(long afterOrdinal, int limit, CancellationToken ct)
    {
        var query = new QueryDefinition(
                "SELECT * FROM c WHERE c.payload.ordinal > @after ORDER BY c.payload.ordinal ASC OFFSET 0 LIMIT @limit")
            .WithParameter("@after", afterOrdinal)
            .WithParameter("@limit", limit);

        var items = await RunQueryAsync(query, ct).ConfigureAwait(false);
        long? next = limit > 0 && items.Count == limit ? items[^1].Ordinal : null;
        return new Page<Civilization>(items, next);
    }

    public async Task UpsertAsync(Civilization civilization, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(civilization);

        var existing = await ReadDocAsync(civilization.CivId, ct).ConfigureAwait(false);
        if (existing is not null)
        {
            civilization.Ordinal = existing.Payload.Ordinal; // Ordinal is assigned once, at first insert.
            var response = await _container.UpsertItemAsync(
                CosmosDoc.Create(civilization.CivId, civilization.CivId, civilization),
                new PartitionKey(civilization.CivId), cancellationToken: ct).ConfigureAwait(false);
            civilization.Etag = response.ETag;
            return;
        }

        await _ordinals.AllocateAsync(
            MaxOrdinalAsync,
            async (next, token) =>
            {
                civilization.Ordinal = next;
                try
                {
                    var created = await _container.CreateItemAsync(
                        CosmosDoc.Create(civilization.CivId, civilization.CivId, civilization),
                        new PartitionKey(civilization.CivId), cancellationToken: token).ConfigureAwait(false);
                    civilization.Etag = created.ETag;
                    return new SequenceInsert<bool>(true, true);
                }
                catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.Conflict)
                {
                    // Lost a create race (rare; World is sole writer). Preserve the winner's ordinal.
                    var winner = await ReadDocAsync(civilization.CivId, token).ConfigureAwait(false);
                    if (winner is not null)
                    {
                        civilization.Ordinal = winner.Payload.Ordinal;
                    }

                    var upserted = await _container.UpsertItemAsync(
                        CosmosDoc.Create(civilization.CivId, civilization.CivId, civilization),
                        new PartitionKey(civilization.CivId), cancellationToken: token).ConfigureAwait(false);
                    civilization.Etag = upserted.ETag;
                    return new SequenceInsert<bool>(false, false);
                }
            },
            ct).ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<Civilization>> ListAllAsync(CancellationToken ct)
        => await RunQueryAsync(new QueryDefinition("SELECT * FROM c"), ct).ConfigureAwait(false);

    private async Task<CosmosDoc<Civilization>?> ReadDocAsync(string civId, CancellationToken ct)
    {
        try
        {
            var response = await _container.ReadItemAsync<CosmosDoc<Civilization>>(
                civId, new PartitionKey(civId), cancellationToken: ct).ConfigureAwait(false);
            return response.Resource;
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }
    }

    private async Task<List<Civilization>> RunQueryAsync(QueryDefinition query, CancellationToken ct)
    {
        var results = new List<Civilization>();
        using var iterator = _container.GetItemQueryIterator<CosmosDoc<Civilization>>(query);
        while (iterator.HasMoreResults)
        {
            foreach (var doc in await iterator.ReadNextAsync(ct).ConfigureAwait(false))
            {
                results.Add(Hydrate(doc));
            }
        }

        return results;
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

    private static Civilization Hydrate(CosmosDoc<Civilization> doc)
    {
        var civ = doc.Payload;
        civ.Etag = doc.Etag;
        return civ;
    }
}
