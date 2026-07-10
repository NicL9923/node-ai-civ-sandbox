namespace WorldMap.Core.Domain;

/// <summary>Identifier generators for World-assigned resource ids (stable, opaque prefixes).</summary>
public static class Ids
{
    public static string NewCivId() => $"civ_{Slug()}";

    public static string DefaultKeyId() => "key_01";

    public static string NewInteractionId() => $"int_{Slug()}";

    public static string NewCommandId() => $"cmd_{Slug()}";

    public static string NewWorldEventId() => $"world-evt-{Slug()}";

    public static string NewCorrelationId() => $"corr_{Slug()}";

    private static string Slug() => Guid.NewGuid().ToString("N")[..16];
}
