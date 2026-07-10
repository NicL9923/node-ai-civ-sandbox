namespace WorldMap.Core.Domain;

/// <summary>
/// Lifecycle state of an interaction. A STABLE, CLOSED enum owned by the World (unlike
/// the open <c>InteractionKind</c>). Wire values are the lowercase names.
/// </summary>
public enum InteractionStatus
{
    Received,
    Authorized,
    Queued,
    Delivered,
    Acknowledged,
    Rejected,
    Expired,
    Failed,
}

/// <summary>Derived civ liveness classification based on heartbeat freshness. Internal only.</summary>
public enum LivenessStatus
{
    Active,
    Stale,
    Offline,
}

/// <summary>Terminal outcome a civ reports when acking a pulled command.</summary>
public enum CommandAckStatus
{
    Applied,
    Rejected,
    Duplicate,
}

/// <summary>Per-event ingestion outcome within an event batch.</summary>
public enum EventIngestStatus
{
    Accepted,
    Duplicate,
    Rejected,
}

/// <summary>Maps domain enums to their lowercase federation wire strings.</summary>
public static class WireEnum
{
    public static string ToWire(this InteractionStatus status) => status switch
    {
        InteractionStatus.Received => "received",
        InteractionStatus.Authorized => "authorized",
        InteractionStatus.Queued => "queued",
        InteractionStatus.Delivered => "delivered",
        InteractionStatus.Acknowledged => "acknowledged",
        InteractionStatus.Rejected => "rejected",
        InteractionStatus.Expired => "expired",
        InteractionStatus.Failed => "failed",
        _ => "failed",
    };

    public static string ToWire(this CommandAckStatus status) => status switch
    {
        CommandAckStatus.Applied => "applied",
        CommandAckStatus.Rejected => "rejected",
        CommandAckStatus.Duplicate => "duplicate",
        _ => "rejected",
    };

    public static string ToWire(this EventIngestStatus status) => status switch
    {
        EventIngestStatus.Accepted => "accepted",
        EventIngestStatus.Duplicate => "duplicate",
        EventIngestStatus.Rejected => "rejected",
        _ => "rejected",
    };

    public static bool TryParseAckStatus(string? value, out CommandAckStatus status)
    {
        switch (value)
        {
            case "applied": status = CommandAckStatus.Applied; return true;
            case "rejected": status = CommandAckStatus.Rejected; return true;
            case "duplicate": status = CommandAckStatus.Duplicate; return true;
            default: status = CommandAckStatus.Rejected; return false;
        }
    }
}
