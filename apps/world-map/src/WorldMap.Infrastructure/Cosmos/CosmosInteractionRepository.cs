using System.Net;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Configuration;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.Cosmos;

/// <summary>
/// Cosmos-backed interaction ledger (doc id = PK = <c>InteractionId</c>).
///
/// <para><b>Idempotent add.</b> <see cref="AddAsync"/> creates by the deterministic interaction id;
/// a create-conflict is a no-op (a resumed acceptance keeps the original).</para>
///
/// <para><b>CAS update.</b> <see cref="UpdateAsync"/> is a monotonic-version compare-and-set: it
/// reads the stored revision, rejects a stale write (stored version already at/ahead of the incoming
/// version), then <c>Replace</c>s with <c>IfMatchEtag</c>. A 412 (a concurrent writer moved on)
/// returns <c>false</c> rather than throwing, so the caller reloads and retries.</para>
///
/// <para>The single <c>EffectiveExpiresAt</c> is promoted to the queryable top-level
/// <c>expiresAtEpoch</c> (UTC seconds) for the offset-safe expiry sweep.</para>
/// </summary>
public sealed class CosmosInteractionRepository(CosmosClient client, IOptions<WorldMapOptions> options)
    : IInteractionRepository
{
    private readonly Container _container =
        client.GetContainer(options.Value.Storage.DatabaseName, CosmosContainers.Interactions);

    public async Task<Interaction?> GetAsync(string interactionId, CancellationToken ct)
    {
        var doc = await ReadDocAsync(interactionId, ct).ConfigureAwait(false);
        return doc?.Payload;
    }

    public async Task AddAsync(Interaction interaction, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(interaction);
        try
        {
            await _container.CreateItemAsync(
                ToDoc(interaction), new PartitionKey(interaction.InteractionId), cancellationToken: ct).ConfigureAwait(false);
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.Conflict)
        {
            // Idempotent: a resumed acceptance for the same deterministic id keeps the original.
        }
    }

    public async Task<bool> UpdateAsync(Interaction interaction, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(interaction);

        var stored = await ReadDocAsync(interaction.InteractionId, ct).ConfigureAwait(false);
        if (stored is null)
        {
            // No prior revision (Update implies prior Add, but stay consistent with the in-memory
            // reference which inserts): create it.
            try
            {
                await _container.CreateItemAsync(
                    ToDoc(interaction), new PartitionKey(interaction.InteractionId), cancellationToken: ct).ConfigureAwait(false);
                return true;
            }
            catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.Conflict)
            {
                return false; // Someone inserted concurrently — reload and retry.
            }
        }

        if (stored.Payload.Version >= interaction.Version)
        {
            return false; // Stale write — the stored revision moved on.
        }

        try
        {
            var options = new ItemRequestOptions { IfMatchEtag = stored.Etag };
            await _container.ReplaceItemAsync(
                ToDoc(interaction), interaction.InteractionId,
                new PartitionKey(interaction.InteractionId), options, ct).ConfigureAwait(false);
            return true;
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.PreconditionFailed)
        {
            return false; // Concurrent writer won — caller reloads and retries.
        }
    }

    public async Task<IReadOnlyList<Interaction>> ListIncompleteAsync(CancellationToken ct)
    {
        // Cross-partition scan filtered in code so the query stays independent of how the
        // InteractionStep/InteractionStatus enums serialize (MVP resume worker; revisit at scale).
        var query = new QueryDefinition("SELECT * FROM c");
        var results = new List<Interaction>();
        using var iterator = _container.GetItemQueryIterator<CosmosDoc<Interaction>>(query);
        while (iterator.HasMoreResults)
        {
            foreach (var doc in await iterator.ReadNextAsync(ct).ConfigureAwait(false))
            {
                if (!doc.Payload.IsProcessingComplete)
                {
                    results.Add(doc.Payload);
                }
            }
        }

        return results;
    }

    public async Task<IReadOnlyList<Interaction>> ListExpirableAsync(DateTimeOffset now, CancellationToken ct)
    {
        // Narrow by numeric epoch (offset-safe), then apply the closed terminal-state check in code.
        var query = new QueryDefinition(
                "SELECT * FROM c WHERE IS_DEFINED(c.expiresAtEpoch) AND c.expiresAtEpoch != null AND c.expiresAtEpoch <= @now")
            .WithParameter("@now", now.ToUnixTimeSeconds());

        var results = new List<Interaction>();
        using var iterator = _container.GetItemQueryIterator<CosmosDoc<Interaction>>(query);
        while (iterator.HasMoreResults)
        {
            foreach (var doc in await iterator.ReadNextAsync(ct).ConfigureAwait(false))
            {
                if (!doc.Payload.IsTerminal)
                {
                    results.Add(doc.Payload);
                }
            }
        }

        return results;
    }

    private async Task<CosmosDoc<Interaction>?> ReadDocAsync(string interactionId, CancellationToken ct)
    {
        try
        {
            var response = await _container.ReadItemAsync<CosmosDoc<Interaction>>(
                interactionId, new PartitionKey(interactionId), cancellationToken: ct).ConfigureAwait(false);
            return response.Resource;
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }
    }

    private static CosmosDoc<Interaction> ToDoc(Interaction interaction) => CosmosDoc.Create(
        interaction.InteractionId, interaction.InteractionId, interaction,
        expiresAtEpoch: interaction.EffectiveExpiresAt?.ToUnixTimeSeconds());
}
