using System.Net;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Configuration;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.Cosmos;

/// <summary>
/// Cosmos-backed per-civ command queue (partition = <c>targetCivId</c>). Pulls and counts stay
/// within a single partition; the expirable sweep is a cross-partition maintenance query.
/// </summary>
public sealed class CosmosCommandRepository(CosmosClient client, IOptions<WorldMapOptions> options)
    : ICommandRepository
{
    private readonly Container _container =
        client.GetContainer(options.Value.Storage.DatabaseName, CosmosContainers.Commands);

    public async Task<Command?> GetAsync(string targetCivId, string commandId, CancellationToken ct)
    {
        try
        {
            var response = await _container.ReadItemAsync<CosmosDoc<Command>>(
                commandId, new PartitionKey(targetCivId), cancellationToken: ct);
            return Hydrate(response.Resource);
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }
    }

    public async Task AddAsync(Command command, CancellationToken ct)
    {
        var doc = CosmosDoc.Create(command.CommandId, command.TargetCivId, command);
        var response = await _container.CreateItemAsync(
            doc, new PartitionKey(command.TargetCivId), cancellationToken: ct);
        command.Etag = response.ETag;
    }

    public async Task UpdateAsync(Command command, CancellationToken ct)
    {
        var doc = CosmosDoc.Create(command.CommandId, command.TargetCivId, command);
        var response = await _container.UpsertItemAsync(
            doc, new PartitionKey(command.TargetCivId), cancellationToken: ct);
        command.Etag = response.ETag;
    }

    public async Task<IReadOnlyList<Command>> PullAsync(
        string targetCivId, long afterSequence, int limit, CancellationToken ct)
    {
        var query = new QueryDefinition(
                "SELECT * FROM c WHERE c.payload.commandSequence > @after AND c.payload.expired = false " +
                "ORDER BY c.payload.commandSequence ASC OFFSET 0 LIMIT @limit")
            .WithParameter("@after", afterSequence)
            .WithParameter("@limit", limit);

        var requestOptions = new QueryRequestOptions { PartitionKey = new PartitionKey(targetCivId) };

        var results = new List<Command>();
        using var iterator = _container.GetItemQueryIterator<CosmosDoc<Command>>(query, requestOptions: requestOptions);
        while (iterator.HasMoreResults)
        {
            foreach (var doc in await iterator.ReadNextAsync(ct))
            {
                results.Add(Hydrate(doc));
            }
        }

        return results;
    }

    public async Task<int> CountPendingAsync(string targetCivId, CancellationToken ct)
    {
        var query = new QueryDefinition(
            "SELECT VALUE COUNT(1) FROM c WHERE IS_NULL(c.payload.ackStatus) AND c.payload.expired = false");
        var requestOptions = new QueryRequestOptions { PartitionKey = new PartitionKey(targetCivId) };

        using var iterator = _container.GetItemQueryIterator<int>(query, requestOptions: requestOptions);
        var count = 0;
        while (iterator.HasMoreResults)
        {
            foreach (var value in await iterator.ReadNextAsync(ct))
            {
                count += value;
            }
        }

        return count;
    }

    public async Task<IReadOnlyList<Command>> ListExpirableAsync(DateTimeOffset now, CancellationToken ct)
    {
        var query = new QueryDefinition(
                "SELECT * FROM c WHERE IS_NULL(c.payload.ackStatus) AND c.payload.expired = false " +
                "AND IS_DEFINED(c.payload.expiresAt) AND c.payload.expiresAt != null AND c.payload.expiresAt <= @now")
            .WithParameter("@now", now);

        var results = new List<Command>();
        using var iterator = _container.GetItemQueryIterator<CosmosDoc<Command>>(query);
        while (iterator.HasMoreResults)
        {
            foreach (var doc in await iterator.ReadNextAsync(ct))
            {
                results.Add(Hydrate(doc));
            }
        }

        return results;
    }

    private static Command Hydrate(CosmosDoc<Command> doc)
    {
        var command = doc.Payload;
        command.Etag = doc.Etag;
        return command;
    }
}
