using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace WorldMap.Core.Contracts;

/// <summary>Reference to the source civ's internal authorization for an interaction.</summary>
public sealed record AuthorityDecisionDto
{
    [JsonPropertyName("mode")]
    public string? Mode { get; init; }

    [JsonPropertyName("ref")]
    public string? Ref { get; init; }

    [JsonPropertyName("authorizedAt")]
    public DateTimeOffset? AuthorizedAt { get; init; }
}

/// <summary>Typed payload for a <c>contact</c> interaction.</summary>
public sealed record ContactIntentDataDto
{
    [JsonPropertyName("greeting")]
    public required string Greeting { get; init; }

    [JsonPropertyName("purpose")]
    public string? Purpose { get; init; }
}

/// <summary>Typed payload for a <c>message</c> interaction.</summary>
public sealed record MessageIntentDataDto
{
    [JsonPropertyName("body")]
    public required string Body { get; init; }

    [JsonPropertyName("subject")]
    public string? Subject { get; init; }

    [JsonPropertyName("inReplyTo")]
    public string? InReplyTo { get; init; }
}

/// <summary>A President-authorized intent to <c>contact</c> or <c>message</c> another civ.</summary>
public sealed record InteractionRequestDto
{
    [JsonPropertyName("kind")]
    public string? Kind { get; init; }

    [JsonPropertyName("source")]
    public string? Source { get; init; }

    [JsonPropertyName("target")]
    public string? Target { get; init; }

    [JsonPropertyName("authorityDecision")]
    public AuthorityDecisionDto? AuthorityDecision { get; init; }

    [JsonPropertyName("publicNarrative")]
    public string? PublicNarrative { get; init; }

    [JsonPropertyName("payload")]
    public JsonNode? Payload { get; init; }

    [JsonPropertyName("expiresAt")]
    public DateTimeOffset? ExpiresAt { get; init; }
}

/// <summary>The World's record and current status of a submitted interaction.</summary>
public sealed record InteractionDto
{
    [JsonPropertyName("interactionId")]
    public required string InteractionId { get; init; }

    [JsonPropertyName("kind")]
    public required string Kind { get; init; }

    [JsonPropertyName("source")]
    public required string Source { get; init; }

    [JsonPropertyName("target")]
    public required string Target { get; init; }

    [JsonPropertyName("status")]
    public required string Status { get; init; }

    [JsonPropertyName("authorityDecision")]
    public AuthorityDecisionDto? AuthorityDecision { get; init; }

    [JsonPropertyName("publicNarrative")]
    public string? PublicNarrative { get; init; }

    [JsonPropertyName("payload")]
    public JsonNode? Payload { get; init; }

    [JsonPropertyName("public")]
    public required bool Public { get; init; }

    [JsonPropertyName("worldsequence")]
    public string? Worldsequence { get; init; }

    [JsonPropertyName("correlationId")]
    public string? CorrelationId { get; init; }

    [JsonPropertyName("createdAt")]
    public required DateTimeOffset CreatedAt { get; init; }

    [JsonPropertyName("updatedAt")]
    public DateTimeOffset? UpdatedAt { get; init; }

    [JsonPropertyName("expiresAt")]
    public DateTimeOffset? ExpiresAt { get; init; }

    [JsonPropertyName("problem")]
    public JsonNode? Problem { get; init; }
}
