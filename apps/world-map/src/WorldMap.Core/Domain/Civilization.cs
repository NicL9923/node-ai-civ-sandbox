using WorldMap.Core.Contracts;

namespace WorldMap.Core.Domain;

/// <summary>
/// A registered civilization aggregate. Holds the World-owned registry entry plus the
/// latest public projection fields refreshed on heartbeat. The HMAC secret is NOT held
/// here — it lives in <see cref="CivCredential"/> via the secret store.
/// </summary>
public sealed class Civilization
{
    public required string CivId { get; set; }
    public required string KeyId { get; set; }
    public required string DisplayName { get; set; }
    public required string ProtocolVersion { get; set; }
    public CapabilitiesDto? Capabilities { get; set; }

    // --- public projection fields (citizen-safe) ---
    public int Turn { get; set; }
    public bool Running { get; set; }
    public int Population { get; set; }
    public LeaderDto? President { get; set; }
    public EconomySummaryDto? Economy { get; set; }
    public string? LastProcessedWorldCursor { get; set; }
    public DateTimeOffset? ProjectionUpdatedAt { get; set; }

    // --- liveness + bookkeeping ---
    public DateTimeOffset? LastHeartbeatAt { get; set; }
    public DateTimeOffset RegisteredAt { get; set; }

    /// <summary>Stable monotonic ordinal used for deterministic list pagination.</summary>
    public long Ordinal { get; set; }

    /// <summary>Opaque concurrency tag (mirrors the Cosmos _etag where applicable).</summary>
    public string? Etag { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }

    /// <summary>Derives liveness from heartbeat freshness. Internal signal (never in the projection).</summary>
    public LivenessStatus Liveness(DateTimeOffset now, TimeSpan staleAfter, TimeSpan offlineAfter)
    {
        if (LastHeartbeatAt is null)
        {
            return LivenessStatus.Offline;
        }

        var age = now - LastHeartbeatAt.Value;
        if (age >= offlineAfter)
        {
            return LivenessStatus.Offline;
        }

        return age >= staleAfter ? LivenessStatus.Stale : LivenessStatus.Active;
    }

    /// <summary>Projects this civ to its citizen-safe public form (no secrets/keys).</summary>
    public PublicProjectionDto ToProjection() => new()
    {
        CivId = CivId,
        DisplayName = DisplayName,
        ProtocolVersion = ProtocolVersion,
        Turn = Turn,
        Running = Running,
        Population = Population,
        President = President,
        Economy = Economy,
        LastProcessedWorldCursor = LastProcessedWorldCursor,
        Etag = Etag,
        UpdatedAt = ProjectionUpdatedAt ?? RegisteredAt,
    };
}

/// <summary>
/// The S2S HMAC credential binding for a civilization. Persists only references/metadata —
/// <see cref="SecretRef"/> points at the operator-provisioned secret resolved via
/// <c>ISecretStore</c>. No secret material is ever stored here, logged, or projected.
/// </summary>
public sealed class CivCredential
{
    public required string CivId { get; set; }
    public required string KeyId { get; set; }

    /// <summary>Opaque reference to the operator-provisioned shared secret (resolved via ISecretStore).</summary>
    public required string SecretRef { get; set; }

    public bool Active { get; set; } = true;
    public DateTimeOffset CreatedAt { get; set; }
}
