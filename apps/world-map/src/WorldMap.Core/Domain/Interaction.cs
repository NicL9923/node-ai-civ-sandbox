using System.Text.Json.Nodes;
using WorldMap.Core.Contracts;

namespace WorldMap.Core.Domain;

/// <summary>
/// The World's record of an inter-civ interaction plus its lifecycle state machine.
/// Transitions are encapsulated here so the closed <see cref="InteractionStatus"/>
/// lifecycle stays authoritative and testable:
/// <c>Received → Authorized → Queued → Delivered → Acknowledged</c> (with
/// <c>Rejected</c>/<c>Expired</c>/<c>Failed</c> terminal branches).
/// </summary>
public sealed class Interaction
{
    public required string InteractionId { get; set; }
    public required string Kind { get; set; }
    public required string Source { get; set; }
    public required string Target { get; set; }
    public InteractionStatus Status { get; set; } = InteractionStatus.Received;
    public AuthorityDecisionDto? AuthorityDecision { get; set; }
    public string? PublicNarrative { get; set; }
    public JsonNode? Payload { get; set; }
    public bool Public { get; set; } = true;
    public long? Worldsequence { get; set; }
    public string? CorrelationId { get; set; }

    /// <summary>The command queued for the target civ to pull (set at Queue).</summary>
    public string? CommandId { get; set; }

    public JsonNode? Problem { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public DateTimeOffset? ExpiresAt { get; set; }
    public string? Etag { get; set; }

    private static readonly InteractionStatus[] Terminal =
    [
        InteractionStatus.Acknowledged,
        InteractionStatus.Rejected,
        InteractionStatus.Expired,
        InteractionStatus.Failed,
    ];

    public bool IsTerminal => Array.IndexOf(Terminal, Status) >= 0;

    public void Authorize(DateTimeOffset now)
    {
        Status = InteractionStatus.Authorized;
        UpdatedAt = now;
    }

    public void AssignSequence(long worldsequence, DateTimeOffset now)
    {
        Worldsequence = worldsequence;
        UpdatedAt = now;
    }

    public void Queue(string commandId, DateTimeOffset now)
    {
        CommandId = commandId;
        Status = InteractionStatus.Queued;
        UpdatedAt = now;
    }

    public void MarkDelivered(DateTimeOffset now)
    {
        // Only advance forward; a later pull must not regress a terminal interaction.
        if (Status == InteractionStatus.Queued)
        {
            Status = InteractionStatus.Delivered;
            UpdatedAt = now;
        }
    }

    public void Acknowledge(DateTimeOffset now)
    {
        Status = InteractionStatus.Acknowledged;
        UpdatedAt = now;
    }

    public void Reject(JsonNode? problem, DateTimeOffset now)
    {
        Status = InteractionStatus.Rejected;
        Problem = problem;
        UpdatedAt = now;
    }

    public void Expire(DateTimeOffset now)
    {
        Status = InteractionStatus.Expired;
        UpdatedAt = now;
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
        ExpiresAt = ExpiresAt,
        Problem = Problem?.DeepClone(),
    };
}
