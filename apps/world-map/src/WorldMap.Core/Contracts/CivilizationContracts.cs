using System.Text.Json.Serialization;

namespace WorldMap.Core.Contracts;

/// <summary>Capabilities a civ advertises at registration and refreshes on heartbeat.</summary>
public sealed record CapabilitiesDto
{
    [JsonPropertyName("protocolVersion")]
    public required string ProtocolVersion { get; init; }

    [JsonPropertyName("supportedInteractionKinds")]
    public required IReadOnlyList<string> SupportedInteractionKinds { get; init; }

    [JsonPropertyName("maxEventBatchSize")]
    public int? MaxEventBatchSize { get; init; }

    [JsonPropertyName("features")]
    public IReadOnlyList<string>? Features { get; init; }
}

/// <summary>Citizen-safe public reference to a civ's current head of state.</summary>
public sealed record LeaderDto
{
    [JsonPropertyName("ref")]
    public required string Ref { get; init; }

    [JsonPropertyName("name")]
    public required string Name { get; init; }

    [JsonPropertyName("title")]
    public string Title { get; init; } = "President";

    [JsonPropertyName("termNumber")]
    public int? TermNumber { get; init; }
}

/// <summary>Safe, aggregate economy summary for public projection.</summary>
public sealed record EconomySummaryDto
{
    [JsonPropertyName("treasury")]
    public double? Treasury { get; init; }

    [JsonPropertyName("currency")]
    public string Currency { get; init; } = "credits";
}

/// <summary>Compact, citizen-safe public projection of a civilization.</summary>
public sealed record PublicProjectionDto
{
    [JsonPropertyName("civId")]
    public required string CivId { get; init; }

    [JsonPropertyName("displayName")]
    public required string DisplayName { get; init; }

    [JsonPropertyName("protocolVersion")]
    public required string ProtocolVersion { get; init; }

    [JsonPropertyName("turn")]
    public required int Turn { get; init; }

    [JsonPropertyName("running")]
    public required bool Running { get; init; }

    [JsonPropertyName("population")]
    public required int Population { get; init; }

    [JsonPropertyName("president")]
    public LeaderDto? President { get; init; }

    [JsonPropertyName("economy")]
    public EconomySummaryDto? Economy { get; init; }

    [JsonPropertyName("lastProcessedWorldCursor")]
    public string? LastProcessedWorldCursor { get; init; }

    [JsonPropertyName("etag")]
    public string? Etag { get; init; }

    [JsonPropertyName("updatedAt")]
    public required DateTimeOffset UpdatedAt { get; init; }
}

/// <summary>One-time civilization onboarding request.</summary>
public sealed record RegistrationRequestDto
{
    [JsonPropertyName("onboardingToken")]
    public string? OnboardingToken { get; init; }

    [JsonPropertyName("displayName")]
    public string? DisplayName { get; init; }

    [JsonPropertyName("capabilities")]
    public CapabilitiesDto? Capabilities { get; init; }

    [JsonPropertyName("publicKey")]
    public string? PublicKey { get; init; }

    [JsonPropertyName("contact")]
    public string? Contact { get; init; }
}

/// <summary>Result of civilization onboarding. Never contains the HMAC secret.</summary>
public sealed record RegistrationResponseDto
{
    [JsonPropertyName("civId")]
    public required string CivId { get; init; }

    [JsonPropertyName("keyId")]
    public required string KeyId { get; init; }

    [JsonPropertyName("protocolVersion")]
    public required string ProtocolVersion { get; init; }

    [JsonPropertyName("worldBaseUrl")]
    public string? WorldBaseUrl { get; init; }

    [JsonPropertyName("commandsCursor")]
    public string? CommandsCursor { get; init; }

    [JsonPropertyName("registeredAt")]
    public required DateTimeOffset RegisteredAt { get; init; }

    [JsonPropertyName("duplicate")]
    public bool Duplicate { get; init; }
}

/// <summary>Liveness signal pushed by a civ, carrying a compact public projection.</summary>
public sealed record HeartbeatDto
{
    [JsonPropertyName("projection")]
    public PublicProjectionDto? Projection { get; init; }

    [JsonPropertyName("capabilities")]
    public CapabilitiesDto? Capabilities { get; init; }

    [JsonPropertyName("lastProcessedWorldCursor")]
    public string? LastProcessedWorldCursor { get; init; }
}

/// <summary>World's response to a heartbeat, including pull hints.</summary>
public sealed record HeartbeatAckDto
{
    [JsonPropertyName("civId")]
    public required string CivId { get; init; }

    [JsonPropertyName("serverTime")]
    public required DateTimeOffset ServerTime { get; init; }

    [JsonPropertyName("nextHeartbeatInSeconds")]
    public int? NextHeartbeatInSeconds { get; init; }

    [JsonPropertyName("pendingCommandCount")]
    public int? PendingCommandCount { get; init; }

    [JsonPropertyName("commandsCursor")]
    public string? CommandsCursor { get; init; }
}

/// <summary>A cursor-paginated page of public civilization projections.</summary>
public sealed record CivilizationListPageDto
{
    [JsonPropertyName("items")]
    public required IReadOnlyList<PublicProjectionDto> Items { get; init; }

    [JsonPropertyName("nextCursor")]
    public string? NextCursor { get; init; }
}
