using System.Text.Json.Serialization;

namespace WorldMap.Infrastructure.Cosmos;

/// <summary>
/// Thin at-rest envelope wrapping a domain aggregate for Cosmos.
///
/// <para>
/// Cosmos requires a lowercase <c>id</c> and that the partition-key path exist on the document.
/// Our aggregates carry natural ids (CivId, InteractionId, …) but no <c>id</c>/partition property,
/// so rather than pollute the domain we wrap each aggregate. For consistency across every
/// container we use a single uniform partition-key path <c>/pk</c> whose VALUE is the aggregate's
/// natural partition (civId, interactionId, targetCivId, pairKey, the constant "public" feed, …).
/// </para>
///
/// <para>
/// <c>_etag</c> is the Cosmos system concurrency tag; it is populated on reads/queries and mapped
/// onto aggregates that expose an <c>Etag</c> field. <c>ttl</c> is honored only on containers with
/// time-to-live enabled (nonces, idempotency).
/// </para>
/// </summary>
internal sealed class CosmosDoc<T>
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = default!;

    [JsonPropertyName("pk")]
    public string Pk { get; set; } = default!;

    [JsonPropertyName("payload")]
    public T Payload { get; set; } = default!;

    /// <summary>Cosmos-managed concurrency tag (read-only from our perspective).</summary>
    [JsonPropertyName("_etag")]
    public string? Etag { get; set; }

    /// <summary>Per-item time-to-live in seconds; ignored unless the container has TTL enabled.</summary>
    [JsonPropertyName("ttl")]
    public int? Ttl { get; set; }

    /// <summary>
    /// Denormalized expiry as UTC epoch SECONDS (int64), promoted to the top level so expiry sweeps
    /// compare numerically (<c>c.expiresAtEpoch &lt;= @now</c>) instead of lexically over ISO-8601
    /// <c>DateTimeOffset</c> strings — which would mis-order values written with differing offsets.
    /// Null on containers that don't query by expiry.
    /// </summary>
    [JsonPropertyName("expiresAtEpoch")]
    public long? ExpiresAtEpoch { get; set; }
}

/// <summary>Factory helpers for <see cref="CosmosDoc{T}"/> so call sites stay terse.</summary>
internal static class CosmosDoc
{
    public static CosmosDoc<T> Create<T>(string id, string pk, T payload, int? ttl = null, long? expiresAtEpoch = null) => new()
    {
        Id = id,
        Pk = pk,
        Payload = payload,
        Ttl = ttl,
        ExpiresAtEpoch = expiresAtEpoch,
    };
}
