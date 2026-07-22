using System.Net;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Configuration;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.Cosmos;

/// <summary>
/// Cosmos-backed per-account rate-limit state (doc id = PK = <c>AccountId</c>). Single writer, so
/// <see cref="UpsertAsync"/> is a plain create-or-replace. A per-item TTL derived from the caller's
/// <c>expiresAt</c> self-purges idle window state on the TTL-enabled container.
/// </summary>
public sealed class CosmosSocialRateLimitStore : ISocialRateLimitStore
{
    private readonly Container _container;

    public CosmosSocialRateLimitStore(CosmosClient client, IOptions<WorldMapOptions> options)
    {
        ArgumentNullException.ThrowIfNull(client);
        ArgumentNullException.ThrowIfNull(options);
        _container = client.GetContainer(options.Value.Storage.DatabaseName, CosmosContainers.SocialRateLimit);
    }

    public async Task<SocialRateLimitState?> GetAsync(string accountId, CancellationToken ct)
    {
        try
        {
            var response = await _container.ReadItemAsync<CosmosDoc<SocialRateLimitState>>(
                accountId, new PartitionKey(accountId), cancellationToken: ct).ConfigureAwait(false);
            var state = response.Resource.Payload;
            state.Etag = response.Resource.Etag;
            return state;
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }
    }

    public async Task UpsertAsync(SocialRateLimitState state, DateTimeOffset expiresAt, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(state);
        var expiresEpoch = expiresAt.ToUnixTimeSeconds();
        var ttl = (int)Math.Max(1, Math.Ceiling((expiresAt - DateTimeOffset.UtcNow).TotalSeconds));
        var doc = CosmosDoc.Create(state.AccountId, state.AccountId, state, ttl: ttl, expiresAtEpoch: expiresEpoch);
        var response = await _container.UpsertItemAsync(
            doc, new PartitionKey(state.AccountId), cancellationToken: ct).ConfigureAwait(false);
        state.Etag = response.ETag;
    }
}
