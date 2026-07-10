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

    public StorageOptions Storage { get; set; } = new();
    public OnboardingOptions Onboarding { get; set; } = new();
    public LivenessOptions Liveness { get; set; } = new();
    public InteractionOptions Interaction { get; set; } = new();
    public EventOptions Events { get; set; } = new();
    public SecretsOptions Secrets { get; set; } = new();
    public MaintenanceOptions Maintenance { get; set; } = new();
    public TelemetryOptions Telemetry { get; set; } = new();
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
