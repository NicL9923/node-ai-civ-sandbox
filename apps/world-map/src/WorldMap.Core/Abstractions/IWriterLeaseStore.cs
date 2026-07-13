namespace WorldMap.Core.Abstractions;

/// <summary>
/// Single-writer lease. The World is the sole writer for the inter-civ registry, so for the MVP it
/// runs at App Service scale = 1. This lease is a fail-closed defense: an instance may act as the
/// writer only while it holds the lease; a second live instance is rejected, fails readiness, and
/// must not run background mutations. It is NOT a scale-out sequencer — the sequence allocator's
/// own ETag/conditional increment remains the guard against counter duplication during any brief
/// overlap window.
/// </summary>
public interface IWriterLeaseStore
{
    /// <summary>
    /// Acquires the lease for <paramref name="instanceId"/>, or renews it if this instance already
    /// holds it, or takes it over if the current holder's lease has expired. Returns <c>false</c> when
    /// a different instance holds an unexpired lease.
    /// </summary>
    Task<bool> TryAcquireOrRenewAsync(string instanceId, DateTimeOffset now, TimeSpan leaseDuration, CancellationToken ct);

    /// <summary>Best-effort release if held by this instance (graceful shutdown → faster failover).</summary>
    Task ReleaseAsync(string instanceId, DateTimeOffset now, CancellationToken ct);
}

/// <summary>
/// Process-wide flag for whether THIS instance currently holds the single-writer lease. Maintained by
/// the lease worker; read by the readiness probe (fail non-ready when not held) and the maintenance
/// worker (skip sweeps when not held). For the InMemory provider it is initialized held (a single
/// in-process instance is inherently the sole writer).
/// </summary>
public sealed class WriterLeaseState(bool initiallyHeld = false)
{
    private volatile bool _held = initiallyHeld;

    public bool IsHeld
    {
        get => _held;
        set => _held = value;
    }
}
