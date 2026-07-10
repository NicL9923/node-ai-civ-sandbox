namespace WorldMap.Core.Abstractions;

/// <summary>Outcome of a readiness probe: whether the dependency is ready plus an optional detail.</summary>
public readonly record struct ReadinessResult(bool Ready, string? Detail = null);

/// <summary>
/// Probes the required backing dependencies (storage, secret provisioning, onboarding config) so the
/// readiness endpoint can fail non-200 during an outage or missing schema — as opposed to liveness,
/// which only reports that the process is running.
/// </summary>
public interface IReadinessProbe
{
    Task<ReadinessResult> CheckAsync(CancellationToken ct);
}
