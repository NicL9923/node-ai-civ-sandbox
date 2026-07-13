using WorldMap.Core.Abstractions;

namespace WorldMap.Infrastructure.InMemory;

/// <summary>Readiness probe for the in-memory provider: the in-process stores are always ready.</summary>
public sealed class InMemoryReadinessProbe : IReadinessProbe
{
    public Task<ReadinessResult> CheckAsync(CancellationToken ct)
        => Task.FromResult(new ReadinessResult(true, "InMemory storage ready."));
}
