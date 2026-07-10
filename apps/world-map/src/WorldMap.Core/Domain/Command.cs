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

    /// <summary>
    /// True once the ack outcome has been propagated to the linked interaction. A crash after the
    /// command reaches a terminal ack but before the interaction is reconciled leaves this false,
    /// so the worker (or an ack replay) can repair the interaction.
    /// </summary>
    public bool AckReconciled { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
    public string? Etag { get; set; }

    /// <summary>Optimistic-concurrency version for compare-and-set ack transitions.</summary>
    public int Version { get; set; }

    public bool IsAcked => AckStatus is not null;

    /// <summary>A command is pullable only while un-acked and un-expired.</summary>
    public bool IsPullable => AckStatus is null && !Expired;

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
/// A public world event in the ordered ledger, backing the citizen-facing <c>/events</c> feed and
/// SSE stream. To keep the public feed citizen-safe, the World NEVER reflects arbitrary producer
/// <c>data</c>: only <see cref="PublicData"/> — either world-built (interaction summaries) or null
/// for civ-ingested events — is exposed, and it is bounded at append time. Raw producer payloads
/// are not stored here.
/// </summary>
public sealed class WorldEvent
{
    public required string EventId { get; set; }
    public long Worldsequence { get; set; }

    public required string Type { get; set; }
    public required string Source { get; set; }
    public string? Subject { get; set; }
    public DateTimeOffset? Time { get; set; }

    /// <summary>
    /// Citizen-safe, bounded public payload. World-built for interaction events; null for
    /// civ-ingested events (whose arbitrary producer data is never surfaced publicly).
    /// </summary>
    public JsonNode? PublicData { get; set; }

    public string? CorrelationId { get; set; }
    public string? CausationId { get; set; }

    /// <summary>Source civ id for civ-ingested events (null for world-originated events).</summary>
    public string? SourceCiv { get; set; }

    /// <summary>Producer-scoped dedupe identity (never the raw event id alone).</summary>
    public required string DedupeKey { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>Citizen-safe public projection — envelope metadata plus the bounded public data only.</summary>
    public CloudEventDto ToPublicDto() => new()
    {
        Id = EventId,
        Specversion = "1.0",
        Type = Type,
        Source = Source,
        Subject = Subject,
        Time = Time,
        Datacontenttype = PublicData is null ? null : "application/json",
        Data = PublicData?.DeepClone(),
        Correlationid = CorrelationId,
        Causationid = CausationId,
        Worldsequence = Worldsequence.ToString(),
    };
}

