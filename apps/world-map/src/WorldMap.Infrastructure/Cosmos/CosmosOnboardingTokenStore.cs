using System.Net;
using System.Text.Json.Serialization;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Configuration;

namespace WorldMap.Infrastructure.Cosmos;

/// <summary>
/// Cosmos-backed one-time onboarding reservation, keyed ONLY by the SHA-256 token HASH (doc id = PK =
/// the lowercase-hex hash). The raw token is never persisted, used as an id/partition key, or logged.
/// A token hash reserves at most one civ; the reservation is a create-wins race and is idempotent for
/// the SAME civ (a 409 reads the owner and returns whether it matches), so a resumed registration
/// re-reserves without burning the token while a different civ is rejected.
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

    public async Task<bool> TryReserveAsync(string tokenHash, string civId, CancellationToken ct)
    {
        // tokenHash is already a lowercase-hex SHA-256 (Cosmos-id-safe) — use it directly, never the raw token.
        var doc = CosmosDoc.Create(tokenHash, tokenHash, new OnboardingMarker(civId, DateTimeOffset.UtcNow));

        try
        {
            await _container.CreateItemAsync(doc, new PartitionKey(tokenHash), cancellationToken: ct).ConfigureAwait(false);
            return true;
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.Conflict)
        {
            try
            {
                var existing = await _container.ReadItemAsync<CosmosDoc<OnboardingMarker>>(
                    tokenHash, new PartitionKey(tokenHash), cancellationToken: ct).ConfigureAwait(false);
                return existing.Resource.Payload.CivId == civId; // Idempotent for the same civ.
            }
            catch (CosmosException readEx) when (readEx.StatusCode == HttpStatusCode.NotFound)
            {
                return false;
            }
        }
    }

    private sealed record OnboardingMarker(
        [property: JsonPropertyName("civId")] string CivId,
        [property: JsonPropertyName("reservedAt")] DateTimeOffset ReservedAt);
}
