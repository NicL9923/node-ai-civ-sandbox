using WorldMap.Core.Abstractions;

namespace WorldMap.Infrastructure.InMemory;

/// <summary>
/// In-memory single-writer lease. Used directly for the InMemory provider (a single in-process
/// instance) and as a deterministic reference for two-instance lease tests: acquire, renew,
/// expiry-driven takeover, and rejection of a live different holder all run against one shared store.
/// </summary>
public sealed class InMemoryWriterLeaseStore : IWriterLeaseStore
{
    private readonly Lock _gate = new();
    private string? _holder;
    private DateTimeOffset _expiresAt;

    public Task<bool> TryAcquireOrRenewAsync(string instanceId, DateTimeOffset now, TimeSpan leaseDuration, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            // Acquire if unheld, already ours (renew), or the current holder's lease has expired.
            if (_holder is null || _holder == instanceId || _expiresAt <= now)
            {
                _holder = instanceId;
                _expiresAt = now.Add(leaseDuration);
                return Task.FromResult(true);
            }

            return Task.FromResult(false); // A different instance holds an unexpired lease.
        }
    }

    public Task ReleaseAsync(string instanceId, DateTimeOffset now, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            if (_holder == instanceId)
            {
                _holder = null;
                _expiresAt = now;
            }
        }

        return Task.CompletedTask;
    }
}
