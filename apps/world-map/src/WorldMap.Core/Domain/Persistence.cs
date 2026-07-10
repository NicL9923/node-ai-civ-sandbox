namespace WorldMap.Core.Domain;

/// <summary>
/// Stored original result of an idempotent mutating operation. Keyed by
/// <c>{operation}:{civId}:{Idempotency-Key}</c> so replays return the original
/// response instead of re-executing the effect.
/// </summary>
public sealed class IdempotencyRecord
{
    public required string Scope { get; set; }
    public required string ResponseJson { get; set; }
    public int StatusCode { get; set; }
    public string? Location { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset ExpiresAt { get; set; }
}

/// <summary>A forward-only page over an ordinal-keyed collection.</summary>
public sealed record Page<T>(IReadOnlyList<T> Items, long? NextOrdinal);
