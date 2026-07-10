namespace WorldMap.Core.Configuration;

/// <summary>
/// Strongly-typed World runtime configuration (bound from the <c>WorldMap</c> section).
/// Secrets are never stored here — onboarding tokens are operator-provisioned and the
/// KEK is a Key Vault reference resolved by the host.
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
    public SecretsOptions Secrets { get; set; } = new();
    public MaintenanceOptions Maintenance { get; set; } = new();
    public TelemetryOptions Telemetry { get; set; } = new();
}

public sealed class StorageOptions
{
    /// <summary>"InMemory" (default) or "Cosmos".</summary>
    public string Provider { get; set; } = "InMemory";

    public string? CosmosEndpoint { get; set; }
    public string DatabaseName { get; set; } = "worldmap";
}

public sealed class OnboardingOptions
{
    /// <summary>
    /// Operator-preprovisioned onboarding records. Each maps a one-time token to the
    /// civId/keyId/secretRef the civilization will be bound to at registration. The World
    /// never mints the HMAC secret — it is provisioned out-of-band and referenced by
    /// <c>SecretRef</c>.
    /// </summary>
    public List<OnboardingRecord> Records { get; set; } = [];
}

/// <summary>
/// A preprovisioned onboarding binding. The token is consumed once; on registration the
/// civilization is bound to the fixed <see cref="CivId"/>/<see cref="KeyId"/> and its secret
/// is resolved via <see cref="SecretRef"/>.
/// </summary>
public sealed class OnboardingRecord
{
    public string Token { get; set; } = string.Empty;
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
