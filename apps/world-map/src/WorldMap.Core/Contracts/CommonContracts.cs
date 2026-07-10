using System.Text.Json.Serialization;

namespace WorldMap.Core.Contracts;

// Wire DTOs mirroring packages/federation-contracts/openapi/world.v1.yaml exactly.
// These are the authoritative System.Text.Json shapes for the World runtime and are
// conformance-tested against the generated contract artifacts and example fixtures.
// worldsequence is a decimal STRING (never a number); nullable optional fields are
// omitted on write (schema permits omission) via WhenWritingNull in JsonOptions.

/// <summary>Standard 202 Accepted body for an asynchronously accepted mutation.</summary>
public sealed record AcceptedDto
{
    [JsonPropertyName("status")]
    public string Status { get; init; } = "accepted";

    [JsonPropertyName("resourceId")]
    public string? ResourceId { get; init; }

    [JsonPropertyName("statusUrl")]
    public required string StatusUrl { get; init; }

    [JsonPropertyName("duplicate")]
    public bool Duplicate { get; init; }
}
