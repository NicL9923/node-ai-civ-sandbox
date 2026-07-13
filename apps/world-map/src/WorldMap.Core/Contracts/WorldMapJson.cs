using System.Text.Json;
using System.Text.Json.Serialization;

namespace WorldMap.Core.Contracts;

/// <summary>
/// The single canonical System.Text.Json configuration for the federation wire format.
/// DTOs carry explicit <c>[JsonPropertyName]</c> attributes, so property naming is driven
/// by those; null-valued optional properties are omitted on write (the schema permits
/// omission for every nullable field). Shared by the API serializer and by services that
/// (de)serialize stored idempotency responses so behavior is identical everywhere.
/// </summary>
public static class WorldMapJson
{
    public static readonly JsonSerializerOptions Options = Create();

    private static JsonSerializerOptions Create()
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        };
        return options;
    }
}
