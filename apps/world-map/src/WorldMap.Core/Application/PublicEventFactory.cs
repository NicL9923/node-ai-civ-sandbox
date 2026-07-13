using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Options;
using WorldMap.Core.Configuration;
using WorldMap.Core.Contracts;

namespace WorldMap.Core.Application;

/// <summary>
/// Builds citizen-safe, bounded public payloads for the world-event ledger. The World NEVER
/// reflects arbitrary producer <c>data</c> publicly: interaction events get a small allowlisted
/// summary; civ-ingested events get no public data at all. All public data is size-capped.
/// </summary>
public sealed class PublicEventFactory(IOptions<WorldMapOptions> options)
{
    private readonly EventOptions _events = options.Value.Events;

    /// <summary>Public summary for a <c>contact</c> interaction (allowlisted fields only).</summary>
    public JsonNode? Contact(string fromCiv, string fromDisplayName, string? publicNarrative)
        => Bound(new JsonObject
        {
            ["kind"] = "contact",
            ["fromCiv"] = fromCiv,
            ["fromDisplayName"] = fromDisplayName,
            ["publicNarrative"] = publicNarrative,
        });

    /// <summary>Public summary for a <c>message</c> interaction (subject only; body is not public).</summary>
    public JsonNode? Message(string fromCiv, string fromDisplayName, string? subject, string? publicNarrative)
        => Bound(new JsonObject
        {
            ["kind"] = "message",
            ["fromCiv"] = fromCiv,
            ["fromDisplayName"] = fromDisplayName,
            ["subject"] = subject,
            ["publicNarrative"] = publicNarrative,
        });

    private JsonNode? Bound(JsonObject node)
    {
        var bytes = System.Text.Encoding.UTF8.GetByteCount(node.ToJsonString(WorldMapJson.Options));
        return bytes <= _events.MaxPublicDataBytes ? node : null;
    }

    public int MaxPublicPageBytes => _events.MaxPublicPageBytes;
}
