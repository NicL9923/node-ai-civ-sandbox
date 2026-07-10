using WorldMap.Core.Contracts;

namespace WorldMap.Core.Abstractions;

/// <summary>
/// Receives citizen-safe public world events at commit time so a shared SSE broadcaster can fan them
/// out without per-client polling. Implementations must be non-blocking (fire-and-forget) so
/// ingestion latency is unaffected. A no-op default is used when no live subscribers exist.
/// </summary>
public interface IWorldEventSink
{
    void Publish(CloudEventDto publicEvent);
}

/// <summary>Default sink that discards events (used when SSE fan-out is not wired).</summary>
public sealed class NoOpWorldEventSink : IWorldEventSink
{
    public void Publish(CloudEventDto publicEvent)
    {
    }
}
