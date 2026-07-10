using Microsoft.Extensions.Logging;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Common;
using WorldMap.Core.Contracts;
using WorldMap.Core.Domain;

namespace WorldMap.Core.Application.Impl;

/// <summary>
/// World-originated command pull + ack for a civ. Commands persist per target civ and are
/// pulled via a forward-only cursor, so an offline civ misses nothing. Pulling a command
/// linked to an interaction advances that interaction to <c>delivered</c>; acking it
/// advances to <c>acknowledged</c> or <c>rejected</c>. Re-acking is idempotent.
/// </summary>
public sealed class CommandService(
    ICommandRepository commands,
    IInteractionRepository interactions,
    TimeProvider clock,
    ILogger<CommandService> logger) : ICommandService
{
    public async Task<Result<CommandPageDto>> PullAsync(string civId, string? after, int? limit, CancellationToken ct)
    {
        if (!CursorCodec.TryDecode(after, out var afterSequence))
        {
            return ErrorResult.Create(ErrorCode.ValidationFailed, "Invalid 'after' cursor.");
        }

        var clamped = Pagination.ClampLimit(limit);
        var pulled = await commands.PullAsync(civId, afterSequence, clamped, ct);

        var now = clock.GetUtcNow();
        foreach (var command in pulled)
        {
            if (command.InteractionId is null)
            {
                continue;
            }

            var interaction = await interactions.GetAsync(command.InteractionId, ct);
            if (interaction is { Status: InteractionStatus.Queued })
            {
                interaction.MarkDelivered(now);
                await interactions.UpdateAsync(interaction, ct);
            }
        }

        var items = pulled.Select(c => c.ToDto()).ToList();
        var nextCursor = pulled.Count > 0 ? CursorCodec.Encode(pulled[^1].CommandSequence) : null;

        return new CommandPageDto { Items = items, NextCursor = nextCursor };
    }

    public async Task<Result<CommandAckResultDto>> AckAsync(
        string civId,
        string commandId,
        CommandAckDto request,
        string idempotencyKey,
        CancellationToken ct)
    {
        var command = await commands.GetAsync(civId, commandId, ct);
        if (command is null)
        {
            return ErrorResult.Create(ErrorCode.CommandNotFound, $"Command '{commandId}' not found for civilization '{civId}'.");
        }

        // Idempotent: re-acking returns the original result with duplicate = true.
        if (command.IsAcked)
        {
            return new CommandAckResultDto
            {
                CommandId = commandId,
                Status = command.AckStatus!.Value.ToWire(),
                Duplicate = true,
                AcknowledgedAt = command.AckedAt,
            };
        }

        if (!WireEnum.TryParseAckStatus(request.Status, out var ackStatus))
        {
            return ErrorResult.Create(ErrorCode.ValidationFailed, "Ack status must be 'applied', 'rejected' or 'duplicate'.",
                errors: [new FieldError("/status", "Unknown ack status.")]);
        }

        var now = clock.GetUtcNow();
        command.AckStatus = ackStatus;
        command.AckedAt = now;
        await commands.UpdateAsync(command, ct);

        if (command.InteractionId is not null)
        {
            var interaction = await interactions.GetAsync(command.InteractionId, ct);
            if (interaction is not null && !interaction.IsTerminal)
            {
                switch (ackStatus)
                {
                    case CommandAckStatus.Applied:
                    case CommandAckStatus.Duplicate:
                        interaction.Acknowledge(now);
                        break;
                    case CommandAckStatus.Rejected:
                        interaction.Reject(request.Problem?.DeepClone(), now);
                        break;
                }

                await interactions.UpdateAsync(interaction, ct);
            }
        }

        logger.LogDebug("Command {CommandId} acked by {CivId} as {Status}.", commandId, civId, ackStatus.ToWire());
        return new CommandAckResultDto
        {
            CommandId = commandId,
            Status = ackStatus.ToWire(),
            Duplicate = false,
            AcknowledgedAt = now,
        };
    }
}
