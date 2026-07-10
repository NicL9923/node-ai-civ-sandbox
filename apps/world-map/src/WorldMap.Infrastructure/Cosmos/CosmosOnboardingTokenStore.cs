using System.Net;
using System.Text.Json.Serialization;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Configuration;

namespace WorldMap.Infrastructure.Cosmos;

/// <summary>
/// Cosmos-backed one-time onboarding token consumption tracker (partition = <c>token</c>).
/// The onboarding service validates the token against the provisioned records; this store only
/// guarantees a token binds at most one civ via a create-wins race.
/// </summary>
public sealed class CosmosOnboardingTokenStore : IOnboardingTokenStore
{
    private readonly Container _container;

    public CosmosOnboardingTokenStore(CosmosClient client, IOptions<WorldMapOptions> options)
    {
        ArgumentNullException.ThrowIfNull(client);
        ArgumentNullException.ThrowIfNull(options);
        _container = client.GetContainer(options.Value.Storage.DatabaseName, CosmosContainers.Onboarding);
    }

    public async Task<bool> TryConsumeAsync(string token, string civId, CancellationToken ct)
    {
        var doc = CosmosDoc.Create(CosmosId.Hash(token), token, new OnboardingMarker(civId, DateTimeOffset.UtcNow));

        try
        {
            await _container.CreateItemAsync(doc, new PartitionKey(token), cancellationToken: ct);
            return true;
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.Conflict)
        {
            return false;
        }
    }

    private sealed record OnboardingMarker(
        [property: JsonPropertyName("civId")] string CivId,
        [property: JsonPropertyName("consumedAt")] DateTimeOffset ConsumedAt);
}
