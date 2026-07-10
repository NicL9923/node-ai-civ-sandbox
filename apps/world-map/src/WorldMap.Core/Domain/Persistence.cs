namespace WorldMap.Core.Domain;

/// <summary>Lifecycle state of an idempotency claim.</summary>
public enum IdempotencyState
{
    /// <summary>The claim is owned and effects are in progress; no response is stored yet.</summary>
    Pending,

    /// <summary>The operation finished; the exact original response is stored for replay.</summary>
    Completed,
}

/// <summary>
/// Durable idempotency record for a mutating operation. A claim is first written in
/// <see cref="IdempotencyState.Pending"/> (owning the scope before any effect), then finalized to
/// <see cref="IdempotencyState.Completed"/> with the exact original response. The
/// <see cref="Fingerprint"/> is a canonical hash of the request so a replay of the same scope/key
/// with a different body is rejected as a conflict rather than returning a mismatched result.
/// </summary>
public sealed class IdempotencyRecord
{
    /// <summary>Seconds a PENDING claim is owned before it may be reclaimed after a crash.</summary>
    public const int PendingLeaseSeconds = 30;

    public required string Scope { get; set; }
    public required string Fingerprint { get; set; }
    public IdempotencyState State { get; set; } = IdempotencyState.Pending;
    public string? ResponseJson { get; set; }
    public int StatusCode { get; set; }
    public string? Location { get; set; }
    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>
    /// Lease deadline for a PENDING claim. Only once this elapses (the owner presumably crashed) may
    /// another caller atomically reclaim the scope and re-run the (idempotent) effect. Prevents two
    /// callers executing the same effect concurrently.
    /// </summary>
    public DateTimeOffset LeaseExpiresAt { get; set; }

    /// <summary>Final expiry of a COMPLETED record (its stored response is replayable until then).</summary>
    public DateTimeOffset ExpiresAt { get; set; }
}

/// <summary>Outcome of an atomic idempotency claim.</summary>
public enum IdempotencyClaimOutcome
{
    /// <summary>This caller won the claim and owns execution of the effects.</summary>
    Won,

    /// <summary>A concurrent caller with the same fingerprint owns a pending claim; wait/replay.</summary>
    AlreadyPending,

    /// <summary>The operation already completed; the stored response should be replayed.</summary>
    Completed,

    /// <summary>The scope/key was used with a different request fingerprint - a hard conflict.</summary>
    FingerprintConflict,
}

/// <summary>Result of <c>IIdempotencyStore.ClaimAsync</c>: the outcome plus the owning record.</summary>
public readonly record struct IdempotencyClaim(IdempotencyClaimOutcome Outcome, IdempotencyRecord Record);

/// <summary>A forward-only page over an ordinal-keyed collection.</summary>
public sealed record Page<T>(IReadOnlyList<T> Items, long? NextOrdinal);
