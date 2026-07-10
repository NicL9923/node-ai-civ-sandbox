using System.Net;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Configuration;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.Cosmos;

/// <summary>Cosmos-backed interaction ledger (partition = <c>interactionId</c>).</summary>
public sealed class CosmosInteractionRepository(CosmosClient client, IOptions<WorldMapOptions> options)
    : IInteractionRepository
{
    private readonly Container _container =
        client.GetContainer(options.Value.Storage.DatabaseName, CosmosContainers.Interactions);

    public async Task<Interaction?> GetAsync(string interactionId, CancellationToken ct)
    {
        try
        {
            var response = await _container.ReadItemAsync<CosmosDoc<Interaction>>(
                interactionId, new PartitionKey(interactionId), cancellationToken: ct);
            return Hydrate(response.Resource);
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }
    }

    public async Task AddAsync(Interaction interaction, CancellationToken ct)
    {
        var doc = CosmosDoc.Create(interaction.InteractionId, interaction.InteractionId, interaction);
        var response = await _container.CreateItemAsync(
            doc, new PartitionKey(interaction.InteractionId), cancellationToken: ct);
        interaction.Etag = response.ETag;
    }

    public async Task UpdateAsync(Interaction interaction, CancellationToken ct)
    {
        var doc = CosmosDoc.Create(interaction.InteractionId, interaction.InteractionId, interaction);
        var response = await _container.UpsertItemAsync(
            doc, new PartitionKey(interaction.InteractionId), cancellationToken: ct);
        interaction.Etag = response.ETag;
    }

    public async Task<IReadOnlyList<Interaction>> ListExpirableAsync(DateTimeOffset now, CancellationToken ct)
    {
        // Narrow in the store by expiry, then apply the closed terminal-state check in code so the
        // query stays independent of how the InteractionStatus enum serializes. The @now parameter is
        // serialized by the same STJ serializer as the stored value, keeping the comparison consistent.
        var query = new QueryDefinition(
                "SELECT * FROM c WHERE IS_DEFINED(c.payload.expiresAt) AND c.payload.expiresAt != null AND c.payload.expiresAt <= @now")
            .WithParameter("@now", now);

        var results = new List<Interaction>();
        using var iterator = _container.GetItemQueryIterator<CosmosDoc<Interaction>>(query);
        while (iterator.HasMoreResults)
        {
            foreach (var doc in await iterator.ReadNextAsync(ct))
            {
                var interaction = Hydrate(doc);
                if (!interaction.IsTerminal)
                {
                    results.Add(interaction);
                }
            }
        }

        return results;
    }

    private static Interaction Hydrate(CosmosDoc<Interaction> doc)
    {
        var interaction = doc.Payload;
        interaction.Etag = doc.Etag;
        return interaction;
    }
}
