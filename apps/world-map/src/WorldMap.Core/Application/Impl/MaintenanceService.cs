using Microsoft.Extensions.Logging;
using WorldMap.Core.Abstractions;

namespace WorldMap.Core.Application.Impl;

/// <summary>
/// Background maintenance: expires un-acked commands and non-terminal interactions past
/// their <c>expiresAt</c>. Civ liveness is derived on read (not persisted), so the sweep
/// itself performs no outbound civ calls. Invoked periodically by the hosted worker.
/// </summary>
public sealed class MaintenanceService(
    ICommandRepository commands,
    IInteractionRepository interactions,
    TimeProvider clock,
    ILogger<MaintenanceService> logger) : IMaintenanceService
{
    public async Task SweepAsync(CancellationToken ct)
    {
        var now = clock.GetUtcNow();

        var expiredCommands = 0;
        foreach (var command in await commands.ListExpirableAsync(now, ct))
        {
            command.Expired = true;
            await commands.UpdateAsync(command, ct);
            expiredCommands++;
        }

        var expiredInteractions = 0;
        foreach (var interaction in await interactions.ListExpirableAsync(now, ct))
        {
            interaction.Expire(now);
            await interactions.UpdateAsync(interaction, ct);
            expiredInteractions++;
        }

        if (expiredCommands > 0 || expiredInteractions > 0)
        {
            logger.LogInformation(
                "Maintenance sweep expired {Commands} command(s) and {Interactions} interaction(s).",
                expiredCommands, expiredInteractions);
        }
    }
}
