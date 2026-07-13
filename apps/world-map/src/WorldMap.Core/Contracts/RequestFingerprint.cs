using System.Text.Json;
using WorldMap.Core.Common;

namespace WorldMap.Core.Contracts;

/// <summary>
/// Produces a canonical, stable fingerprint of a request body so an idempotency replay with the
/// same scope/key but a different body can be detected as a conflict. The DTO's fixed property
/// order under <see cref="WorldMapJson.Options"/> makes serialization deterministic.
/// </summary>
public static class RequestFingerprint
{
    public static string Of<T>(T request)
    {
        var json = JsonSerializer.Serialize(request, WorldMapJson.Options);
        return Deterministic.Sha256Hex(json);
    }
}
