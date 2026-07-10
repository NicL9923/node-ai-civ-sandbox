using System.Net;
using System.Text.Json.Serialization;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Configuration;

namespace WorldMap.Infrastructure.Cosmos;

/// <summary>
/// Cosmos-backed single-use nonce store (partition = <c>keyId</c>). Replay protection is a
/// create-wins race: the first writer creates the doc (accept); a duplicate hits a 409 (replay).
/// Container TTL purges expired nonces automatically via the per-item <c>ttl</c>.
/// </summary>
public sealed class CosmosNonceStore(CosmosClient client, IOptions<WorldMapOptions> options) : INonceStore
{
    private readonly Container _container =
        client.GetContainer(options.Value.Storage.DatabaseName, CosmosContainers.Nonces);

    public async Task<bool> TryConsumeAsync(string keyId, string nonce, DateTimeOffset expiresAt, CancellationToken ct)
    {
        var ttlSeconds = (int)Math.Max(1, Math.Ceiling((expiresAt - DateTimeOffset.UtcNow).TotalSeconds));
        var id = CosmosId.Hash($"{keyId}|{nonce}");
        var doc = CosmosDoc.Create(id, keyId, new NonceMarker(expiresAt), ttl: ttlSeconds);

        try
        {
            await _container.CreateItemAsync(doc, new PartitionKey(keyId), cancellationToken: ct);
            return true;
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.Conflict)
        {
            return false;
        }
    }

    private sealed record NonceMarker([property: JsonPropertyName("expiresAt")] DateTimeOffset ExpiresAt);
}
