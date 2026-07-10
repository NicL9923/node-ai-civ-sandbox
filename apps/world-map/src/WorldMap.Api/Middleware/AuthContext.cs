namespace WorldMap.Api.Middleware;

/// <summary>
/// The authenticated civilization context established by the HMAC filter and read by
/// endpoints. Stored in <c>HttpContext.Items</c>.
/// </summary>
public sealed record AuthContext(string CivId, string KeyId, string IdempotencyKey)
{
    public const string HttpContextItemKey = "worldmap.auth";
}
