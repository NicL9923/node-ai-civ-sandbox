using System.Text.Json.Serialization;

namespace WorldMap.Core.Contracts;

/// <summary>An unordered pair of civ ids; the World canonicalizes civA &lt;= civB.</summary>
public sealed record CivPairDto
{
    [JsonPropertyName("civA")]
    public required string CivA { get; init; }

    [JsonPropertyName("civB")]
    public required string CivB { get; init; }
}

/// <summary>Public projection of the relationship state between two civilizations.</summary>
public sealed record RelationshipDto
{
    [JsonPropertyName("pair")]
    public required CivPairDto Pair { get; init; }

    [JsonPropertyName("trust")]
    public required double Trust { get; init; }

    [JsonPropertyName("grievance")]
    public required double Grievance { get; init; }

    [JsonPropertyName("threat")]
    public required double Threat { get; init; }

    [JsonPropertyName("familiarity")]
    public required double Familiarity { get; init; }

    [JsonPropertyName("interdependence")]
    public required double Interdependence { get; init; }

    [JsonPropertyName("stance")]
    public required string Stance { get; init; }

    [JsonPropertyName("narrativeSummary")]
    public string? NarrativeSummary { get; init; }

    [JsonPropertyName("version")]
    public required int Version { get; init; }

    [JsonPropertyName("etag")]
    public string? Etag { get; init; }

    [JsonPropertyName("updatedAt")]
    public required DateTimeOffset UpdatedAt { get; init; }
}

/// <summary>A cursor-paginated page of public relationship projections.</summary>
public sealed record RelationshipPageDto
{
    [JsonPropertyName("items")]
    public required IReadOnlyList<RelationshipDto> Items { get; init; }

    [JsonPropertyName("nextCursor")]
    public string? NextCursor { get; init; }
}
