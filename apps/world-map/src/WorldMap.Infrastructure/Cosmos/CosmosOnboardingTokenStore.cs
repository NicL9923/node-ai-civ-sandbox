using System.Net;
using System.Text.Json.Serialization;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Configuration;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.Cosmos;

/// <summary>
/// Cosmos-backed onboarding registration ledger, keyed ONLY by the SHA-256 token HASH (doc id = PK =
/// the lowercase-hex hash). The raw token is never persisted, used as an id/partition key, or logged.
/// A create-wins race records (civ + canonical fingerprint) on first use; a later same-fingerprint
/// request is a replay (do not mutate the civ) and a different fingerprint is a conflict. The record
/// is durable (no TTL), so the "one civ per token" + conflict guarantees survive the idempotency TTL.
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

    public async Task<OnboardingReservationOutcome> ReserveAsync(string tokenHash, string civId, string fingerprint, CancellationToken ct)
    {
        // tokenHash is already a lowercase-hex SHA-256 (Cosmos-id-safe) — use it directly, never the raw token.
        var doc = CosmosDoc.Create(tokenHash, tokenHash, new OnboardingMarker(civId, fingerprint, DateTimeOffset.UtcNow));

        try
        {
            await _container.CreateItemAsync(doc, new PartitionKey(tokenHash), cancellationToken: ct).ConfigureAwait(false);
            return OnboardingReservationOutcome.Reserved;
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.Conflict)
        {
            try
            {
                var existing = await _container.ReadItemAsync<CosmosDoc<OnboardingMarker>>(
                    tokenHash, new PartitionKey(tokenHash), cancellationToken: ct).ConfigureAwait(false);
                return existing.Resource.Payload.Fingerprint == fingerprint
                    ? OnboardingReservationOutcome.DuplicateMatch
                    : OnboardingReservationOutcome.Conflict;
            }
            catch (CosmosException readEx) when (readEx.StatusCode == HttpStatusCode.NotFound)
            {
                return OnboardingReservationOutcome.Conflict;
            }
        }
    }

    private sealed record OnboardingMarker(
        [property: JsonPropertyName("civId")] string CivId,
        [property: JsonPropertyName("fingerprint")] string Fingerprint,
        [property: JsonPropertyName("reservedAt")] DateTimeOffset ReservedAt);
}
