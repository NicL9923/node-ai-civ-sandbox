using System.Text.Json.Nodes;
using WorldMap.Core.Contracts;

namespace WorldMap.Core.Domain;

/// <summary>
/// A world-originated command queued for a specific target civ to PULL and ACK. Stored
/// per target civ and ordered by <see cref="CommandSequence"/> so pulls use a
/// forward-only cursor and an offline civ misses nothing.
/// </summary>
public sealed class Command
{
    public required string CommandId { get; set; }
    public required string TargetCivId { get; set; }

    /// <summary>Per-civ monotonic ordinal backing the forward-only pull cursor.</summary>
    public long CommandSequence { get; set; }

    public long? Worldsequence { get; set; }

    // --- CloudEvent envelope fields ---
    public required string EventId { get; set; }
    public required string Type { get; set; }
    public required string Source { get; set; }
    public string? Subject { get; set; }
    public DateTimeOffset? Time { get; set; }
    public JsonNode? Data { get; set; }
    public string? CorrelationId { get; set; }
    public string? CausationId { get; set; }
    public string? IdempotencyKey { get; set; }

    // --- delivery metadata ---
    public DateTimeOffset DeliveredAt { get; set; }
    public DateTimeOffset? ExpiresAt { get; set; }
    public string? InteractionId { get; set; }

    public CommandAckStatus? AckStatus { get; set; }
    public DateTimeOffset? AckedAt { get; set; }
    public bool Expired { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
    public string? Etag { get; set; }

    public bool IsAcked => AckStatus is not null;

    public CommandDto ToDto() => new()
    {
        Commandid = CommandId,
        Id = EventId,
        Specversion = "1.0",
        Type = Type,
        Source = Source,
        Subject = Subject,
        Time = Time,
        Datacontenttype = "application/json",
        Data = Data?.DeepClone(),
        Correlationid = CorrelationId,
        Causationid = CausationId,
        Idempotencykey = IdempotencyKey,
        Worldsequence = Worldsequence?.ToString(),
        Deliveredat = DeliveredAt,
        Expiresat = ExpiresAt,
    };
}

/// <summary>
/// A public world event in the ordered ledger — both civ-ingested events and
/// world-originated events surface here for the public <c>/events</c> feed and SSE.
/// </summary>
public sealed class WorldEvent
{
    public required string EventId { get; set; }
    public long Worldsequence { get; set; }

    public required string Type { get; set; }
    public required string Source { get; set; }
    public string? Subject { get; set; }
    public DateTimeOffset? Time { get; set; }
    public string? Datacontenttype { get; set; }
    public string? Dataschema { get; set; }
    public JsonNode? Data { get; set; }
    public string? CorrelationId { get; set; }
    public string? CausationId { get; set; }
    public string? IdempotencyKey { get; set; }

    /// <summary>Source civ id for civ-ingested events (null for world-originated events).</summary>
    public string? SourceCiv { get; set; }

    /// <summary>Dedupe key: CloudEvents idempotencykey, else source + id.</summary>
    public required string DedupeKey { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    public CloudEventDto ToDto() => new()
    {
        Id = EventId,
        Specversion = "1.0",
        Type = Type,
        Source = Source,
        Subject = Subject,
        Time = Time,
        Datacontenttype = Datacontenttype,
        Dataschema = Dataschema,
        Data = Data?.DeepClone(),
        Correlationid = CorrelationId,
        Causationid = CausationId,
        Idempotencykey = IdempotencyKey,
        Worldsequence = Worldsequence.ToString(),
    };
}
