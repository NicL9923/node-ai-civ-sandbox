using System.Net;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Configuration;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.Cosmos;

/// <summary>Cosmos-backed S2S credential store (partition = <c>civId</c>).</summary>
public sealed class CosmosCivCredentialRepository(CosmosClient client, IOptions<WorldMapOptions> options)
    : ICivCredentialRepository
{
    private readonly Container _container =
        client.GetContainer(options.Value.Storage.DatabaseName, CosmosContainers.Credentials);

    public async Task<CivCredential?> GetAsync(string civId, CancellationToken ct)
    {
        try
        {
            var response = await _container.ReadItemAsync<CosmosDoc<CivCredential>>(
                civId, new PartitionKey(civId), cancellationToken: ct);
            return response.Resource.Payload;
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }
    }

    public async Task UpsertAsync(CivCredential credential, CancellationToken ct)
    {
        var doc = CosmosDoc.Create(credential.CivId, credential.CivId, credential);
        await _container.UpsertItemAsync(doc, new PartitionKey(credential.CivId), cancellationToken: ct);
    }
}
