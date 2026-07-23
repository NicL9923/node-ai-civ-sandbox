using Microsoft.Extensions.Logging;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Domain;

namespace WorldMap.Core.Application.Impl;

/// <summary>
/// Background maintenance and crash repair. Each sweep: resumes interactions whose process manager
/// did not finish; reconciles acked-but-unreconciled commands into their interactions; and expires
/// commands and interactions past their single effective expiry (an expired command drives its
/// linked interaction terminal). Performs NO outbound civ calls — the World never initiates network
/// calls to civilizations.
/// </summary>
public sealed class MaintenanceService(
    ICommandRepository commands,
    IInteractionRepository interactions,
    IInteractionProcessor processor,
    ISocialPostService socialPosts,
    ISocialGraphService socialGraph,
    TimeProvider clock,
    ILogger<MaintenanceService> logger) : IMaintenanceService
{
    private const int MaxConcurrencyRetries = 8;

    public async Task SweepAsync(CancellationToken ct)
    {
        var now = clock.GetUtcNow();

        await ResumeIncompleteInteractionsAsync(ct);
        await ReconcileAckedCommandsAsync(now, ct);
        var expiredCommands = await ExpireCommandsAsync(now, ct);
        var expiredInteractions = await ExpireInteractionsAsync(now, ct);

        // Repair social crash windows: posts stuck before completing their create state machine, and
        // follow/like transitions committed but not yet evented.
        await socialPosts.RepairIncompleteAsync(ct);
        await socialGraph.RepairPendingAsync(ct);

        if (expiredCommands > 0 || expiredInteractions > 0)
        {
            logger.LogInformation(
                "Maintenance sweep expired {Commands} command(s) and {Interactions} interaction(s).",
                expiredCommands, expiredInteractions);
        }
    }

    private async Task ResumeIncompleteInteractionsAsync(CancellationToken ct)
    {
        foreach (var interaction in await interactions.ListIncompleteAsync(ct))
        {
            await processor.ProcessAsync(interaction.InteractionId, ct);
        }
    }

    private async Task ReconcileAckedCommandsAsync(DateTimeOffset now, CancellationToken ct)
    {
        foreach (var command in await commands.ListUnreconciledAsync(ct))
        {
            if (command.InteractionId is null)
            {
                await commands.MarkAckReconciledAsync(command.TargetCivId, command.CommandId, ct);
                continue;
            }

            var status = command.AckStatus ?? CommandAckStatus.Applied;
            await AdvanceInteractionAsync(command.InteractionId, interaction =>
            {
                if (status == CommandAckStatus.Rejected)
                {
                    interaction.Reject(null, now);
                }
                else
                {
                    interaction.Acknowledge(now);
                }
            }, ct);

            await commands.MarkAckReconciledAsync(command.TargetCivId, command.CommandId, ct);
        }
    }

    private async Task<int> ExpireCommandsAsync(DateTimeOffset now, CancellationToken ct)
    {
        var count = 0;
        foreach (var command in await commands.ListExpirableAsync(now, ct))
        {
            // Only advance the linked interaction to expired when THIS call actually won the
            // command's terminal expiry transition. If an ACK won the race concurrently,
            // MarkExpiredAsync returns false and the interaction is reconciled by the ack path instead.
            if (!await commands.MarkExpiredAsync(command.TargetCivId, command.CommandId, ct))
            {
                continue;
            }

            if (command.InteractionId is not null)
            {
                await AdvanceInteractionAsync(command.InteractionId, i => i.Expire(now), ct);
            }

            count++;
        }

        return count;
    }

    private async Task<int> ExpireInteractionsAsync(DateTimeOffset now, CancellationToken ct)
    {
        var count = 0;
        foreach (var interaction in await interactions.ListExpirableAsync(now, ct))
        {
            if (await AdvanceInteractionAsync(interaction.InteractionId, i => i.Expire(now), ct))
            {
                count++;
            }
        }

        return count;
    }

    private async Task<bool> AdvanceInteractionAsync(string interactionId, Action<Interaction> mutate, CancellationToken ct)
    {
        for (var attempt = 0; attempt < MaxConcurrencyRetries; attempt++)
        {
            var interaction = await interactions.GetAsync(interactionId, ct);
            if (interaction is null)
            {
                return false;
            }

            var before = interaction.Version;
            mutate(interaction);
            if (interaction.Version == before)
            {
                return false; // No-op.
            }

            if (await interactions.UpdateAsync(interaction, ct))
            {
                return true;
            }
        }

        return false;
    }
}
