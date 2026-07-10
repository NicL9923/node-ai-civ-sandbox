using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace WorldMap.Core.Contracts;

/// <summary>
/// A CloudEvents 1.0 event in structured JSON mode, extended with federation
/// attributes. <see cref="CommandDto"/> extends this with command delivery metadata
/// (the OpenAPI <c>allOf</c> flattens to a single JSON object).
/// </summary>
public record CloudEventDto
{
    [JsonPropertyName("id")]
    public required string Id { get; init; }

    [JsonPropertyName("specversion")]
    public string Specversion { get; init; } = "1.0";

    [JsonPropertyName("type")]
    public required string Type { get; init; }

    [JsonPropertyName("source")]
    public required string Source { get; init; }

    [JsonPropertyName("subject")]
    public string? Subject { get; init; }

    [JsonPropertyName("time")]
    public DateTimeOffset? Time { get; init; }

    [JsonPropertyName("datacontenttype")]
    public string? Datacontenttype { get; init; }

    [JsonPropertyName("dataschema")]
    public string? Dataschema { get; init; }

    [JsonPropertyName("data")]
    public JsonNode? Data { get; init; }

    [JsonPropertyName("correlationid")]
    public string? Correlationid { get; init; }

    [JsonPropertyName("causationid")]
    public string? Causationid { get; init; }

    [JsonPropertyName("idempotencykey")]
    public string? Idempotencykey { get; init; }

    [JsonPropertyName("worldsequence")]
    public string? Worldsequence { get; init; }
}

/// <summary>A world-originated command a civ PULLs and then ACKs (CloudEvent + delivery metadata).</summary>
public sealed record CommandDto : CloudEventDto
{
    [JsonPropertyName("commandid")]
    public required string Commandid { get; init; }

    [JsonPropertyName("deliveredat")]
    public DateTimeOffset? Deliveredat { get; init; }

    [JsonPropertyName("expiresat")]
    public DateTimeOffset? Expiresat { get; init; }
}

/// <summary>A civ's acknowledgment that it has processed a pulled command.</summary>
public sealed record CommandAckDto
{
    [JsonPropertyName("status")]
    public string? Status { get; init; }

    [JsonPropertyName("detail")]
    public string? Detail { get; init; }

    [JsonPropertyName("problem")]
    public JsonNode? Problem { get; init; }

    [JsonPropertyName("appliedAt")]
    public DateTimeOffset? AppliedAt { get; init; }
}

/// <summary>The World's response to a command acknowledgment.</summary>
public sealed record CommandAckResultDto
{
    [JsonPropertyName("commandId")]
    public required string CommandId { get; init; }

    [JsonPropertyName("status")]
    public required string Status { get; init; }

    [JsonPropertyName("duplicate")]
    public bool Duplicate { get; init; }

    [JsonPropertyName("acknowledgedAt")]
    public DateTimeOffset? AcknowledgedAt { get; init; }
}

/// <summary>A cursor-paginated page of commands a civ pulls from the World.</summary>
public sealed record CommandPageDto
{
    [JsonPropertyName("items")]
    public required IReadOnlyList<CommandDto> Items { get; init; }

    [JsonPropertyName("nextCursor")]
    public string? NextCursor { get; init; }
}

/// <summary>An at-least-once batch of civ-originated CloudEvents pushed to the World.</summary>
public sealed record EventBatchDto
{
    [JsonPropertyName("events")]
    public IReadOnlyList<CloudEventDto>? Events { get; init; }
}

/// <summary>Per-event result within an event batch response.</summary>
public sealed record EventBatchItemResultDto
{
    [JsonPropertyName("id")]
    public required string Id { get; init; }

    [JsonPropertyName("status")]
    public required string Status { get; init; }

    [JsonPropertyName("worldsequence")]
    public string? Worldsequence { get; init; }

    [JsonPropertyName("problem")]
    public JsonNode? Problem { get; init; }
}

/// <summary>The World's response to an event batch — one result per submitted event.</summary>
public sealed record EventBatchResultDto
{
    [JsonPropertyName("acceptedCount")]
    public int? AcceptedCount { get; init; }

    [JsonPropertyName("duplicateCount")]
    public int? DuplicateCount { get; init; }

    [JsonPropertyName("results")]
    public required IReadOnlyList<EventBatchItemResultDto> Results { get; init; }
}

/// <summary>A cursor-paginated page of public world events.</summary>
public sealed record EventPageDto
{
    [JsonPropertyName("items")]
    public required IReadOnlyList<CloudEventDto> Items { get; init; }

    [JsonPropertyName("nextCursor")]
    public string? NextCursor { get; init; }
}

/// <summary><c>data</c> payload for a <c>world.civilization.contact.v1</c> command.</summary>
public sealed record ContactCommandDataDto
{
    [JsonPropertyName("interactionId")]
    public required string InteractionId { get; init; }

    [JsonPropertyName("fromCiv")]
    public required string FromCiv { get; init; }

    [JsonPropertyName("fromDisplayName")]
    public string? FromDisplayName { get; init; }

    [JsonPropertyName("greeting")]
    public string? Greeting { get; init; }

    [JsonPropertyName("publicNarrative")]
    public string? PublicNarrative { get; init; }
}

/// <summary><c>data</c> payload for a <c>world.civilization.message.v1</c> command.</summary>
public sealed record MessageCommandDataDto
{
    [JsonPropertyName("interactionId")]
    public required string InteractionId { get; init; }

    [JsonPropertyName("fromCiv")]
    public required string FromCiv { get; init; }

    [JsonPropertyName("fromDisplayName")]
    public string? FromDisplayName { get; init; }

    [JsonPropertyName("subject")]
    public string? Subject { get; init; }

    [JsonPropertyName("body")]
    public required string Body { get; init; }

    [JsonPropertyName("inReplyTo")]
    public string? InReplyTo { get; init; }
}
