using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Configuration;

namespace WorldMap.Infrastructure;

/// <summary>
/// Maintains this instance's single-writer lease. Acquires at startup and renews on an interval,
/// publishing the result to <see cref="WriterLeaseState"/>. When another live instance holds the
/// lease, this instance reports not-held — so readiness fails (removing it from rotation) and the
/// maintenance worker skips its sweeps. Releases the lease best-effort on shutdown for faster failover.
/// </summary>
public sealed class WriterLeaseWorker(
    IWriterLeaseStore store,
    WriterLeaseState state,
    TimeProvider clock,
    IOptions<WorldMapOptions> options,
    ILogger<WriterLeaseWorker> logger) : BackgroundService
{
    private readonly string _instanceId = Guid.NewGuid().ToString("N");
    private readonly SingleWriterLeaseOptions _options = options.Value.Storage.SingleWriterLease;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var leaseDuration = TimeSpan.FromSeconds(Math.Max(2, _options.LeaseDurationSeconds));
        var renewInterval = TimeSpan.FromSeconds(Math.Max(1, _options.RenewIntervalSeconds));
        logger.LogInformation(
            "Single-writer lease worker started (instance {InstanceId}, lease {Lease}s, renew {Renew}s).",
            _instanceId, leaseDuration.TotalSeconds, renewInterval.TotalSeconds);

        using var timer = new PeriodicTimer(renewInterval);
        do
        {
            await TryRenewAsync(leaseDuration, stoppingToken).ConfigureAwait(false);
        }
        while (await WaitAsync(timer, stoppingToken).ConfigureAwait(false));

        logger.LogInformation("Single-writer lease worker stopping (instance {InstanceId}).", _instanceId);
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        state.IsHeld = false;
        try
        {
            await store.ReleaseAsync(_instanceId, clock.GetUtcNow(), cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Best-effort single-writer lease release failed on shutdown.");
        }

        await base.StopAsync(cancellationToken).ConfigureAwait(false);
    }

    private async Task TryRenewAsync(TimeSpan leaseDuration, CancellationToken ct)
    {
        try
        {
            var held = await store.TryAcquireOrRenewAsync(_instanceId, clock.GetUtcNow(), leaseDuration, ct).ConfigureAwait(false);
            if (held != state.IsHeld)
            {
                logger.Log(held ? LogLevel.Information : LogLevel.Warning,
                    "Single-writer lease {State} by instance {InstanceId}.", held ? "acquired" : "lost", _instanceId);
            }

            state.IsHeld = held;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Fail closed: on any lease error, treat this instance as not the writer.
            state.IsHeld = false;
            logger.LogWarning(ex, "Single-writer lease renewal failed; treating this instance as not the writer.");
        }
    }

    private static async Task<bool> WaitAsync(PeriodicTimer timer, CancellationToken ct)
    {
        try
        {
            return await timer.WaitForNextTickAsync(ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            return false;
        }
    }
}
