using System.Net;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Configuration;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.Cosmos;

/// <summary>
/// Cosmos-backed idempotency store (partition = <c>scope</c>). <see cref="PutIfAbsentAsync"/> is a
/// create-wins race: the winner's record is returned; a concurrent replay reads back the existing
/// one. Records self-expire via the per-item <c>ttl</c> on a TTL-enabled container.
/// </summary>
public sealed class CosmosIdempotencyStore(CosmosClient client, IOptions<WorldMapOptions> options)
    : IIdempotencyStore
{
    private readonly Container _container =
        client.GetContainer(options.Value.Storage.DatabaseName, CosmosContainers.Idempotency);

    public async Task<IdempotencyRecord?> GetAsync(string scope, CancellationToken ct)
    {
        try
        {
            var response = await _container.ReadItemAsync<CosmosDoc<IdempotencyRecord>>(
                CosmosId.Hash(scope), new PartitionKey(scope), cancellationToken: ct);
            return response.Resource.Payload;
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }
    }

    public async Task<IdempotencyRecord> PutIfAbsentAsync(IdempotencyRecord record, CancellationToken ct)
    {
        var ttlSeconds = (int)Math.Max(1, Math.Ceiling((record.ExpiresAt - DateTimeOffset.UtcNow).TotalSeconds));
        var doc = CosmosDoc.Create(CosmosId.Hash(record.Scope), record.Scope, record, ttl: ttlSeconds);

        try
        {
            var response = await _container.CreateItemAsync(doc, new PartitionKey(record.Scope), cancellationToken: ct);
            return response.Resource.Payload;
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.Conflict)
        {
            // A concurrent writer won: return the record that now owns the scope.
            var existing = await GetAsync(record.Scope, ct);
            return existing ?? record;
        }
    }
}
