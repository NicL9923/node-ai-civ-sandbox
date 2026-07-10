using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Common;
using WorldMap.Core.Configuration;
using WorldMap.Core.Contracts;
using WorldMap.Core.Domain;

namespace WorldMap.Core.Application.Impl;

/// <summary>
/// World-originated command pull + ack for a civ. Pull returns only un-acked, un-expired commands
/// (terminal/expired are never redelivered) and advances the linked interaction to
/// <c>delivered</c>. Ack transitions the command terminally via compare-and-set (concurrent
/// different acks cannot overwrite the first outcome), then reconciles the linked interaction; a
/// crash after the command's terminal transition but before reconciliation is repaired on ack replay
/// or by the maintenance worker.
/// </summary>
public sealed class CommandService(
    ICommandRepository commands,
    IInteractionRepository interactions,
    IdempotencyExecutor idempotency,
    TimeProvider clock,
    IOptions<WorldMapOptions> options,
    ILogger<CommandService> logger) : ICommandService
{
    private const int MaxConcurrencyRetries = 8;
    private readonly WorldMapOptions _options = options.Value;

    public async Task<Result<CommandPageDto>> PullAsync(string civId, string? after, int? limit, CancellationToken ct)
    {
        if (!CursorCodec.TryDecode(after, out var afterSequence))
        {
            return ErrorResult.Create(ErrorCode.ValidationFailed, "Invalid 'after' cursor.");
        }

        var pulled = await commands.PullAsync(civId, afterSequence, Pagination.ClampLimit(limit), ct);
        var now = clock.GetUtcNow();

        foreach (var command in pulled.Where(c => c.InteractionId is not null))
        {
            await AdvanceInteractionAsync(command.InteractionId!, i => i.MarkDelivered(now), ct);
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

        if (!WireEnum.TryParseAckStatus(request.Status, out var ackStatus))
        {
            return ErrorResult.Create(ErrorCode.ValidationFailed, "Ack status must be 'applied', 'rejected' or 'duplicate'.",
                errors: [new FieldError("/status", "Unknown ack status.")]);
        }

        var scope = $"ack:{civId}:{commandId}:{idempotencyKey}";
        var fingerprint = RequestFingerprint.Of(request);
        var ttl = TimeSpan.FromSeconds(_options.Interaction.IdempotencyTtlSeconds);

        var outcome = await idempotency.ExecuteAsync<CommandAckResultDto>(
            scope,
            fingerprint,
            ttl,
            innerCt => ApplyAckAsync(civId, commandId, ackStatus, request.Problem, innerCt),
            body => body with { Duplicate = true },
            ct);

        return outcome.IsSuccess ? outcome.Value.Body : outcome.Error;
    }

    private async Task<Result<OperationOutcome<CommandAckResultDto>>> ApplyAckAsync(
        string civId,
        string commandId,
        CommandAckStatus ackStatus,
        JsonNode? problem,
        CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        var transition = await commands.TryAckAsync(civId, commandId, ackStatus, now, ct);
        var command = transition.Command;

        // Reconcile the linked interaction (idempotent; repairs a crash between the command's
        // terminal transition and interaction reconciliation).
        if (command.InteractionId is not null && !command.AckReconciled)
        {
            await ReconcileInteractionAsync(command, now, ct);
            await commands.MarkAckReconciledAsync(civId, commandId, ct);
        }

        // The authoritative status is the winning ack; a losing concurrent ack reports duplicate.
        var result = new CommandAckResultDto
        {
            CommandId = commandId,
            Status = (command.AckStatus ?? ackStatus).ToWire(),
            Duplicate = !transition.Won,
            AcknowledgedAt = command.AckedAt ?? now,
        };

        logger.LogDebug("Command {CommandId} ack by {CivId}: status {Status}, won {Won}.",
            commandId, civId, result.Status, transition.Won);
        return new OperationOutcome<CommandAckResultDto>(result, 200, null);
    }

    private async Task ReconcileInteractionAsync(Command command, DateTimeOffset now, CancellationToken ct)
    {
        var status = command.AckStatus ?? CommandAckStatus.Applied;
        await AdvanceInteractionAsync(command.InteractionId!, interaction =>
        {
            switch (status)
            {
                case CommandAckStatus.Applied:
                case CommandAckStatus.Duplicate:
                    interaction.Acknowledge(now);
                    break;
                case CommandAckStatus.Rejected:
                    interaction.Reject(command.Data is null ? null : BuildRejectProblem(), now);
                    break;
            }
        }, ct);
    }

    /// <summary>Loads, mutates and persists an interaction with optimistic-concurrency retry.</summary>
    private async Task AdvanceInteractionAsync(string interactionId, Action<Interaction> mutate, CancellationToken ct)
    {
        for (var attempt = 0; attempt < MaxConcurrencyRetries; attempt++)
        {
            var interaction = await interactions.GetAsync(interactionId, ct);
            if (interaction is null)
            {
                return;
            }

            var before = interaction.Version;
            mutate(interaction);
            if (interaction.Version == before)
            {
                return; // No-op (already in the target state).
            }

            if (await interactions.UpdateAsync(interaction, ct))
            {
                return;
            }
        }

        logger.LogWarning("Interaction {InteractionId} reconciliation exhausted retries; worker will resume.", interactionId);
    }

    private static JsonNode BuildRejectProblem() => new JsonObject
    {
        ["type"] = "about:blank",
        ["title"] = "Command rejected by target",
        ["status"] = 409,
        ["code"] = "command_rejected",
        ["retryable"] = false,
    };
}
