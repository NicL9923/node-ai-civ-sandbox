using System.Text.Json;

namespace WorldMap.Infrastructure.InMemory;

/// <summary>
/// Deep-copies aggregates for the in-memory stores so a caller mutating a fetched aggregate cannot
/// corrupt stored state before an explicit update — making optimistic-concurrency (version CAS)
/// semantics honest and matching how a real durable store behaves.
/// </summary>
internal static class InMemoryClone
{
    private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.General);

    public static T Copy<T>(T value)
    {
        var json = JsonSerializer.Serialize(value, Options);
        return JsonSerializer.Deserialize<T>(json, Options)!;
    }
}
