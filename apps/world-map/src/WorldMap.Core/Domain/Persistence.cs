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
    /// Opaque token identifying the current owner of a PENDING claim. A fresh token is issued each
    /// time the claim is granted (initial win or a post-lease reclaim). Only the holder of the
    /// current token may Complete or Release, so a crashed owner that resumes after its lease was
    /// taken over cannot overwrite the new owner's result.
    /// </summary>
    public string LeaseToken { get; set; } = "";

    /// <summary>
    /// Lease deadline for a PENDING claim. Only once this elapses (the owner presumably crashed) may
    /// another caller <b>with the same fingerprint</b> atomically reclaim the scope and re-run the
    /// (idempotent) effect. Lease expiry does NOT delete the record: the record persists for the full
    /// idempotency TTL (<see cref="ExpiresAt"/>) so a different-fingerprint request is still rejected.
    /// </summary>
    public DateTimeOffset LeaseExpiresAt { get; set; }

    /// <summary>
    /// Final expiry of the record (both pending and completed). The record — and thus its
    /// fingerprint-conflict guard — lives until this instant; a completed record's stored response is
    /// replayable until then.
    /// </summary>
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

/// <summary>
/// Outcome of a durable onboarding token reservation (keyed by token hash). The reservation persists
/// the provisioned civ and the canonical registration fingerprint for the life of the token.
/// </summary>
public enum OnboardingReservationOutcome
{
    /// <summary>First use of this token hash: the token/civ/fingerprint were reserved now.</summary>
    Reserved,

    /// <summary>The token was already reserved with the SAME fingerprint: a replay (do not mutate the civ).</summary>
    DuplicateMatch,

    /// <summary>The token was already reserved with a DIFFERENT fingerprint: a registration conflict.</summary>
    Conflict,
}

/// <summary>A forward-only page over an ordinal-keyed collection.</summary>
public sealed record Page<T>(IReadOnlyList<T> Items, long? NextOrdinal);
