using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Application;
using WorldMap.Core.Configuration;

namespace WorldMap.Api.Workers;

/// <summary>
/// Periodic maintenance worker: expires stale commands/interactions and (implicitly)
/// keeps derived liveness current. Performs NO outbound civ calls — the World never
/// initiates network calls to civilizations. Skips its sweep whenever this instance does not hold
/// the single-writer lease, so background mutations run on at most one instance.
/// </summary>
public sealed class WorldMaintenanceWorker(
    IServiceScopeFactory scopeFactory,
    WriterLeaseState leaseState,
    IOptions<WorldMapOptions> options,
    ILogger<WorldMaintenanceWorker> logger) : BackgroundService
{
    private readonly MaintenanceOptions _options = options.Value.Maintenance;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_options.Enabled)
        {
            logger.LogInformation("World maintenance worker disabled by configuration.");
            return;
        }

        var interval = TimeSpan.FromSeconds(Math.Max(1, _options.SweepIntervalSeconds));
        logger.LogInformation("World maintenance worker started; sweep interval {Interval}.", interval);

        using var timer = new PeriodicTimer(interval);
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                // Only the single-writer lease holder runs mutations.
                if (!leaseState.IsHeld)
                {
                    logger.LogDebug("Skipping maintenance sweep: this instance does not hold the single-writer lease.");
                }
                else
                {
                    await using var scope = scopeFactory.CreateAsyncScope();
                    var maintenance = scope.ServiceProvider.GetRequiredService<IMaintenanceService>();
                    await maintenance.SweepAsync(stoppingToken);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                // A failed sweep must not crash the host; log and retry next tick.
                logger.LogError(ex, "World maintenance sweep failed; will retry next interval.");
            }

            try
            {
                await timer.WaitForNextTickAsync(stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }

        logger.LogInformation("World maintenance worker stopping.");
    }
}
