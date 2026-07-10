using System.Text.Json.Nodes;
using WorldMap.Core.Common;
using WorldMap.Core.Contracts;

namespace WorldMap.Core.Domain;

/// <summary>
/// The World's record of an inter-civ interaction plus its durable, resumable process state.
///
/// <para>Acceptance is persisted BEFORE any downstream effect, so a crash leaves a resumable
/// interaction. The process manager advances <see cref="Step"/> through idempotent stages
/// (append public event → update relationship → enqueue command → queued). All repair artifacts
/// (<see cref="CommandId"/>, <see cref="EventId"/>) are DETERMINISTIC — derived from the
/// interaction id — so a resumed step reuses the same identity and never double-writes.</para>
///
/// <para>The wire-facing <see cref="Status"/> (a closed contract enum) is derived from
/// <see cref="Step"/>; <see cref="Version"/> drives optimistic concurrency.</para>
/// </summary>
public sealed class Interaction
{
    public required string InteractionId { get; set; }
    public required string Kind { get; set; }
    public required string Source { get; set; }
    public required string Target { get; set; }
    public InteractionStatus Status { get; set; } = InteractionStatus.Received;

    /// <summary>Internal process-manager progress (resume point after a crash).</summary>
    public InteractionStep Step { get; set; } = InteractionStep.Accepted;

    public AuthorityDecisionDto? AuthorityDecision { get; set; }
    public string? PublicNarrative { get; set; }
    public JsonNode? Payload { get; set; }
    public bool Public { get; set; } = true;
    public long? Worldsequence { get; set; }
    public string? CorrelationId { get; set; }

    /// <summary>Deterministic id of the command queued for the target (derived from the interaction id).</summary>
    public required string CommandId { get; set; }

    /// <summary>Deterministic id of the public world event (derived from the interaction id).</summary>
    public required string EventId { get; set; }

    public JsonNode? Problem { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }

    /// <summary>The single effective expiry shared by the interaction and its command.</summary>
    public DateTimeOffset? EffectiveExpiresAt { get; set; }

    /// <summary>Optimistic-concurrency version, incremented on every persisted transition.</summary>
    public int Version { get; set; }

    private static readonly InteractionStatus[] Terminal =
    [
        InteractionStatus.Acknowledged,
        InteractionStatus.Rejected,
        InteractionStatus.Expired,
        InteractionStatus.Failed,
    ];

    public bool IsTerminal => Array.IndexOf(Terminal, Status) >= 0;

    /// <summary>True once the process manager has queued the command (or reached a terminal state).</summary>
    public bool IsProcessingComplete => Step == InteractionStep.Done || IsTerminal;

    /// <summary>Derives the deterministic command id for an interaction id.</summary>
    public static string DeriveCommandId(string interactionId) => Deterministic.Id("cmd_", "command", interactionId);

    /// <summary>Derives the deterministic public-event id for an interaction id.</summary>
    public static string DeriveEventId(string interactionId) => Deterministic.Id("world-evt-", "event", interactionId);

    public void AdvanceStep(InteractionStep step, DateTimeOffset now)
    {
        if (step > Step)
        {
            Step = step;
        }

        Touch(now);
    }

    public void MarkAuthorized(DateTimeOffset now)
    {
        if (Status == InteractionStatus.Received)
        {
            Status = InteractionStatus.Authorized;
        }

        AdvanceStep(InteractionStep.Authorized, now);
    }

    public void MarkQueued(DateTimeOffset now)
    {
        // Only advance forward; never regress a terminal/delivered interaction.
        if (Status is InteractionStatus.Received or InteractionStatus.Authorized)
        {
            Status = InteractionStatus.Queued;
        }

        AdvanceStep(InteractionStep.Done, now);
    }

    public void MarkDelivered(DateTimeOffset now)
    {
        if (Status == InteractionStatus.Queued)
        {
            Status = InteractionStatus.Delivered;
            Touch(now);
        }
    }

    public void Acknowledge(DateTimeOffset now)
    {
        if (!IsTerminal)
        {
            Status = InteractionStatus.Acknowledged;
            Touch(now);
        }
    }

    public void Reject(JsonNode? problem, DateTimeOffset now)
    {
        if (!IsTerminal)
        {
            Status = InteractionStatus.Rejected;
            Problem = problem;
            Touch(now);
        }
    }

    public void Expire(DateTimeOffset now)
    {
        if (!IsTerminal)
        {
            Status = InteractionStatus.Expired;
            Touch(now);
        }
    }

    private void Touch(DateTimeOffset now)
    {
        UpdatedAt = now;
        Version++;
    }

    public InteractionDto ToDto() => new()
    {
        InteractionId = InteractionId,
        Kind = Kind,
        Source = Source,
        Target = Target,
        Status = Status.ToWire(),
        AuthorityDecision = AuthorityDecision,
        PublicNarrative = PublicNarrative,
        Payload = Payload?.DeepClone(),
        Public = Public,
        Worldsequence = Worldsequence?.ToString(),
        CorrelationId = CorrelationId,
        CreatedAt = CreatedAt,
        UpdatedAt = UpdatedAt,
        ExpiresAt = EffectiveExpiresAt,
        Problem = Problem?.DeepClone(),
    };
}
