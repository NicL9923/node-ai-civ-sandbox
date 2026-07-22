namespace WorldMap.Core.Configuration;

/// <summary>Supported storage providers (explicit allowlist; invalid values fail startup).</summary>
public enum StorageProvider
{
    InMemory,
    Cosmos,
}

/// <summary>
/// Strongly-typed World runtime configuration (bound from the <c>WorldMap</c> section).
/// Secrets are never stored here — onboarding tokens are referenced by hash and the actual HMAC
/// secrets are resolved out-of-band via <c>ISecretStore</c>.
/// </summary>
public sealed class WorldMapOptions
{
    public const string SectionName = "WorldMap";

    public string ProtocolVersion { get; set; } = "1.0.0";

    /// <summary>Base URL returned to civs (e.g. https://world.example.com/world/v1).</summary>
    public string WorldBaseUrl { get; set; } = "https://world.example.com/world/v1";

    /// <summary>
    /// Optional physical directory to serve the observer SPA (built web assets) from. When unset,
    /// static files are served from the app's default web root (wwwroot). Host wiring only — this
    /// is not part of the federation contract.
    /// </summary>
    public string? WebRoot { get; set; }

    public StorageOptions Storage { get; set; } = new();
    public OnboardingOptions Onboarding { get; set; } = new();
    public LivenessOptions Liveness { get; set; } = new();
    public InteractionOptions Interaction { get; set; } = new();
    public EventOptions Events { get; set; } = new();
    public SecretsOptions Secrets { get; set; } = new();
    public MaintenanceOptions Maintenance { get; set; } = new();
    public TelemetryOptions Telemetry { get; set; } = new();
    public SocialOptions Social { get; set; } = new();
}

public sealed class StorageOptions
{
    /// <summary>Storage provider. Must parse to a <see cref="StorageProvider"/> value; validated at startup.</summary>
    public string Provider { get; set; } = "InMemory";

    /// <summary>
    /// When true, allows the non-durable InMemory provider outside Development. Left false in
    /// production so a misconfiguration fails fast rather than silently losing data.
    /// </summary>
    public bool AllowInMemoryOutsideDevelopment { get; set; }

    public string? CosmosEndpoint { get; set; }
    public string DatabaseName { get; set; } = "worldmap";

    /// <summary>
    /// When true, the Cosmos bootstrapper creates the database/containers if missing. Default FALSE:
    /// normal runtime only validates that required containers/PK paths/TTL exist and readiness-fails
    /// otherwise. Enable only for explicit dev/first-run provisioning.
    /// </summary>
    public bool BootstrapEnabled { get; set; }

    /// <summary>Single-writer lease settings (Cosmos provider). Fail-closed defense for scale = 1.</summary>
    public SingleWriterLeaseOptions SingleWriterLease { get; set; } = new();
}

/// <summary>
/// Single-writer lease configuration. The World runs at App Service scale = 1 for the MVP; the lease
/// ensures that if a second instance ever runs, only one acts as the writer and the other fails
/// readiness. Not a scale-out sequencer.
/// </summary>
public sealed class SingleWriterLeaseOptions
{
    /// <summary>When true (default), a Cosmos instance must hold the writer lease to be ready/mutate.</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>Lease duration; a holder that stops renewing loses the lease after this long.</summary>
    public int LeaseDurationSeconds { get; set; } = 30;

    /// <summary>How often the holder renews (should be well below the lease duration).</summary>
    public int RenewIntervalSeconds { get; set; } = 10;
}

public sealed class OnboardingOptions
{
    /// <summary>
    /// Operator-preprovisioned onboarding records. Each maps a one-time token (by hash) to the
    /// fixed civId/keyId/secretRef the civilization is bound to. The World never mints the HMAC
    /// secret — it is provisioned out-of-band and referenced by <c>SecretRef</c>.
    /// </summary>
    public List<OnboardingRecord> Records { get; set; } = [];
}

/// <summary>
/// A preprovisioned onboarding binding. Provide <see cref="TokenHash"/> (a lowercase-hex SHA-256 of
/// the token) — the preferred, secret-free form. <see cref="Token"/> is accepted only as a
/// convenience at the process boundary and is immediately hashed and discarded; the raw token is
/// never persisted, logged, or used as an id/partition key.
/// </summary>
public sealed class OnboardingRecord
{
    public string? Token { get; set; }
    public string? TokenHash { get; set; }
    public string CivId { get; set; } = string.Empty;
    public string KeyId { get; set; } = "key_01";
    public string SecretRef { get; set; } = string.Empty;
}

public sealed class SecretsOptions
{
    /// <summary>
    /// Reference-to-secret map for the configuration-backed secret store. In production these
    /// entries are App Service settings backed by Key Vault references; locally they may be
    /// supplied via appsettings/user-secrets/env. Never commit real secrets.
    /// </summary>
    public Dictionary<string, string> Map { get; set; } = new(StringComparer.Ordinal);
}

public sealed class LivenessOptions
{
    public int StaleAfterSeconds { get; set; } = 90;
    public int OfflineAfterSeconds { get; set; } = 300;
    public int SuggestedHeartbeatSeconds { get; set; } = 30;
}

public sealed class InteractionOptions
{
    public int CommandTtlSeconds { get; set; } = 604800; // 7 days
    public int IdempotencyTtlSeconds { get; set; } = 86400; // 24 hours
}

public sealed class EventOptions
{
    /// <summary>Maximum events per ingestion batch.</summary>
    public int MaxBatchSize { get; set; } = 500;

    /// <summary>Maximum serialized bytes of a single event's public data (over-limit data is dropped).</summary>
    public int MaxPublicDataBytes { get; set; } = 4096;

    /// <summary>Maximum serialized bytes of a public event feed page.</summary>
    public int MaxPublicPageBytes { get; set; } = 262144;

    /// <summary>
    /// Maximum serialized bytes of a single accepted CloudEvent envelope (id/type/source/data/
    /// extensions/etc.). Kept well under the Cosmos ~2 MB item limit so every persisted event fits.
    /// </summary>
    public int MaxEventBytes { get; set; } = 65536;

    /// <summary>Maximum aggregate serialized bytes of an entire ingestion batch request.</summary>
    public int MaxBatchBytes { get; set; } = 1048576;

    /// <summary>Maximum characters for any single string envelope field (id/type/source/subject/ids).</summary>
    public int MaxFieldChars { get; set; } = 1024;

    /// <summary>Maximum number of additive CloudEvents extension attributes on one event.</summary>
    public int MaxExtensions { get; set; } = 32;
}

public sealed class MaintenanceOptions
{
    public int SweepIntervalSeconds { get; set; } = 30;
    public bool Enabled { get; set; } = true;
}

public sealed class TelemetryOptions
{
    /// <summary>App Insights / Azure Monitor connection string; when null, exporter is disabled.</summary>
    public string? AzureMonitorConnectionString { get; set; }
}

/// <summary>
/// World Wire social runtime configuration. The <b>structural</b> bounds (text/display/bio code points,
/// reply depth, sync batch size, page limits) are fixed by the contract and defaulted here; the
/// <see cref="RateLimit"/> quota numbers are deployment policy advertised to civs via
/// <c>SocialRateLimitPolicy</c>.
/// </summary>
public sealed class SocialOptions
{
    /// <summary>Maximum accounts in one atomic sync batch (contract-fixed 100).</summary>
    public int MaxSyncBatch { get; set; } = 100;

    /// <summary>Maximum post/reply text length in Unicode code points (contract-fixed 280).</summary>
    public int MaxTextCodePoints { get; set; } = 280;

    /// <summary>Maximum display-name length in Unicode code points (contract-fixed 80).</summary>
    public int MaxDisplayNameCodePoints { get; set; } = 80;

    /// <summary>Maximum bio length in Unicode code points (contract-fixed 160).</summary>
    public int MaxBioCodePoints { get; set; } = 160;

    /// <summary>Maximum reply depth (root is 0; contract-fixed maximum 4).</summary>
    public int MaxReplyDepth { get; set; } = 4;

    /// <summary>Default social page size (contract default 25).</summary>
    public int DefaultPageLimit { get; set; } = 25;

    /// <summary>Maximum social page size (contract-fixed 100).</summary>
    public int MaxPageLimit { get; set; } = 100;

    /// <summary>Following-feed durable snapshot time-to-live.</summary>
    public int SnapshotTtlSeconds { get; set; } = 3600;

    /// <summary>Idempotency record time-to-live for social mutations.</summary>
    public int IdempotencyTtlSeconds { get; set; } = 86400;

    public SocialRateLimitOptions RateLimit { get; set; } = new();

    public int ClampPageLimit(int? limit) =>
        limit is null ? DefaultPageLimit : Math.Clamp(limit.Value, 1, MaxPageLimit);
}

/// <summary>Per-account anti-spam quota policy advertised via <c>SocialRateLimitPolicy</c>.</summary>
public sealed class SocialRateLimitOptions
{
    public int PostCooldownSeconds { get; set; } = 30;
    public int PostsPerWindow { get; set; } = 20;
    public int ReactionsPerWindow { get; set; } = 120;
    public int FollowsPerWindow { get; set; } = 60;
    public int WindowSeconds { get; set; } = 3600;
}
