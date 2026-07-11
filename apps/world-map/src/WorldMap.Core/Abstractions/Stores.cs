using WorldMap.Core.Domain;

namespace WorldMap.Core.Abstractions;

/// <summary>
/// Resolves an S2S HMAC shared secret by its opaque reference. Secrets are provisioned
/// out-of-band by an operator (App Service / Key Vault-referenced config for MVP) and are
/// NEVER minted, returned, or stored by the runtime — only referenced. Plaintext is never
/// logged or projected. Registration persists a <c>secretRef</c> on the credential and this
/// store resolves the actual secret for signature verification.
/// </summary>
public interface ISecretStore
{
    /// <summary>Resolves the plaintext secret for a reference, or null when unknown/unprovisioned.</summary>
    string? GetSecret(string secretRef);
}

/// <summary>
/// Single-use nonce store for HMAC replay protection. A nonce is scoped by
/// <c>civId + keyId + nonce</c> and consumed ONLY after protocol/timestamp/signature validation
/// succeed. The entry's expiry is <c>signedTimestamp + replayWindow</c> (not verification time),
/// so a future-dated but valid request cannot be replayed after an early expiry.
/// </summary>
public interface INonceStore
{
    /// <summary>
    /// Atomically records a nonce for a (civId, keyId). Returns <c>true</c> if unused within the
    /// window (accept), <c>false</c> if already seen (replay). <paramref name="expiresAt"/> must be
    /// derived from the signed timestamp.
    /// </summary>
    Task<bool> TryConsumeAsync(string civId, string keyId, string nonce, DateTimeOffset expiresAt, DateTimeOffset now, CancellationToken ct);
}

/// <summary>
/// Idempotency store with an explicit claim/complete lifecycle. A caller first atomically CLAIMS a
/// scope (writing a pending record that owns execution), performs the effects, then COMPLETES the
/// claim with the exact response. Replays observe the completed response; a different request
/// fingerprint for the same scope is a hard conflict.
/// </summary>
public interface IIdempotencyStore
{
    /// <summary>
    /// Atomically claims a scope for a request fingerprint. See <see cref="IdempotencyClaimOutcome"/>
    /// for the four outcomes. The fingerprint is compared BEFORE any lease-reclaim: a different
    /// fingerprint is always a conflict for the full idempotency TTL, regardless of lease state; only
    /// the SAME fingerprint may reclaim a pending claim whose lease has elapsed. A <c>Won</c> claim's
    /// <see cref="IdempotencyRecord.LeaseToken"/> identifies this owner for Complete/Release.
    /// </summary>
    Task<IdempotencyClaim> ClaimAsync(string scope, string fingerprint, DateTimeOffset now, DateTimeOffset expiresAt, CancellationToken ct);

    /// <summary>
    /// Finalizes an owned pending claim with the exact original response. Applies only when the
    /// current record is still pending, the fingerprint matches, AND <paramref name="leaseToken"/>
    /// matches the current owner — so a stale owner that resumes after a lease takeover cannot
    /// overwrite the new owner's completion.
    /// </summary>
    Task CompleteAsync(string scope, string fingerprint, string leaseToken, string responseJson, int statusCode, string? location, DateTimeOffset now, CancellationToken ct);

    /// <summary>
    /// Releases an owned pending claim (a failed effect) so a retry can immediately re-claim and
    /// re-run rather than waiting out the lease. Applies only when the record is pending, the
    /// fingerprint matches, AND <paramref name="leaseToken"/> matches the current owner. No-op
    /// otherwise (completed, different fingerprint, or a stale token after takeover).
    /// </summary>
    Task ReleaseAsync(string scope, string fingerprint, string leaseToken, CancellationToken ct);

    /// <summary>Reads the current record for a scope (used by losers polling for a completed result).</summary>
    Task<IdempotencyRecord?> GetAsync(string scope, CancellationToken ct);
}

/// <summary>
/// Durable onboarding registration ledger keyed by the SHA-256 HASH of the presented token. The raw
/// token is never persisted, used as a document id / partition key, or logged. Each token hash
/// reserves at most one civilization and records the canonical registration fingerprint, so a later
/// request with the same token replays (same fingerprint) or conflicts (different fingerprint) —
/// independently of any HTTP Idempotency-Key.
/// </summary>
public interface IOnboardingTokenStore
{
    /// <summary>
    /// Atomically records (token hash → civ + fingerprint) on first use. Returns
    /// <see cref="OnboardingReservationOutcome.Reserved"/> on first use,
    /// <see cref="OnboardingReservationOutcome.DuplicateMatch"/> when the same fingerprint is presented
    /// again (a replay; the civ must not be mutated), or
    /// <see cref="OnboardingReservationOutcome.Conflict"/> for a different fingerprint.
    /// <paramref name="tokenHash"/> is a lowercase-hex SHA-256.
    /// </summary>
    Task<OnboardingReservationOutcome> ReserveAsync(string tokenHash, string civId, string fingerprint, CancellationToken ct);
}
