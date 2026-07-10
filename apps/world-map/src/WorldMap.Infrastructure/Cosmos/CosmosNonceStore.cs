using System.Net;
using System.Text.Json.Serialization;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Configuration;

namespace WorldMap.Infrastructure.Cosmos;

/// <summary>
/// Cosmos-backed single-use nonce store for HMAC replay protection, scoped by
/// <c>civId + keyId + nonce</c> (doc id = SHA-256 of all three; PK = <c>keyId</c>). Two civs sharing
/// a <c>keyId</c>+<c>nonce</c> therefore never collide.
///
/// <para>Replay protection is a create-wins race: the first writer creates the doc (accept); a
/// duplicate within the window hits a 409 (replay). The window is the SIGNED-timestamp-derived
/// <c>expiresAt</c>, persisted both as a per-item <c>ttl</c> (auto-purge) and the numeric top-level
/// <c>expiresAtEpoch</c> — so on a 409 a logically-expired marker (epoch ≤ now) that the TTL sweep
/// hasn't reaped yet is reclaimed rather than rejected, matching the in-memory reference exactly.</para>
/// </summary>
public sealed class CosmosNonceStore(CosmosClient client, IOptions<WorldMapOptions> options) : INonceStore
{
    private const int MaxAttempts = 3;

    private readonly Container _container =
        client.GetContainer(options.Value.Storage.DatabaseName, CosmosContainers.Nonces);

    public async Task<bool> TryConsumeAsync(
        string civId, string keyId, string nonce, DateTimeOffset expiresAt, DateTimeOffset now, CancellationToken ct)
    {
        var id = CosmosId.Hash($"{civId}|{keyId}|{nonce}");
        var pk = new PartitionKey(keyId);
        var nowEpoch = now.ToUnixTimeSeconds();

        for (var attempt = 0; attempt < MaxAttempts; attempt++)
        {
            var doc = ToDoc(id, keyId, civId, expiresAt, now);
            try
            {
                await _container.CreateItemAsync(doc, pk, cancellationToken: ct).ConfigureAwait(false);
                return true; // First use within the window.
            }
            catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.Conflict)
            {
                var existing = await ReadDocAsync(id, pk, ct).ConfigureAwait(false);
                if (existing is null)
                {
                    continue; // Raced with a TTL purge — retry the create.
                }

                var epoch = existing.ExpiresAtEpoch ?? existing.Payload.ExpiresAt.ToUnixTimeSeconds();
                if (epoch > nowEpoch)
                {
                    return false; // Live marker — replay within the window.
                }

                // Logically expired but not yet reaped: reclaim in place.
                try
                {
                    var replaceOptions = new ItemRequestOptions { IfMatchEtag = existing.Etag };
                    await _container.ReplaceItemAsync(doc, id, pk, replaceOptions, ct).ConfigureAwait(false);
                    return true;
                }
                catch (CosmosException replaceEx) when (replaceEx.StatusCode == HttpStatusCode.PreconditionFailed)
                {
                    return false; // Another request reclaimed it first — treat as replay.
                }
            }
        }

        return false;
    }

    private async Task<CosmosDoc<NonceMarker>?> ReadDocAsync(string id, PartitionKey pk, CancellationToken ct)
    {
        try
        {
            var response = await _container.ReadItemAsync<CosmosDoc<NonceMarker>>(id, pk, cancellationToken: ct)
                .ConfigureAwait(false);
            return response.Resource;
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }
    }

    private static CosmosDoc<NonceMarker> ToDoc(string id, string keyId, string civId, DateTimeOffset expiresAt, DateTimeOffset now)
    {
        var ttlSeconds = (int)Math.Max(1, Math.Ceiling((expiresAt - now).TotalSeconds));
        return CosmosDoc.Create(id, keyId, new NonceMarker(civId, expiresAt), ttl: ttlSeconds, expiresAtEpoch: expiresAt.ToUnixTimeSeconds());
    }

    private sealed record NonceMarker(
        [property: JsonPropertyName("civId")] string CivId,
        [property: JsonPropertyName("expiresAt")] DateTimeOffset ExpiresAt);
}
