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
    /// for the four outcomes. Expired records are treated as absent (reclaimable).
    /// </summary>
    Task<IdempotencyClaim> ClaimAsync(string scope, string fingerprint, DateTimeOffset now, DateTimeOffset expiresAt, CancellationToken ct);

    /// <summary>Finalizes an owned pending claim with the exact original response for future replays.</summary>
    Task CompleteAsync(string scope, string fingerprint, string responseJson, int statusCode, string? location, DateTimeOffset now, CancellationToken ct);

    /// <summary>
    /// Releases an owned pending claim (a failed effect), so a retry can immediately re-claim and
    /// re-run rather than waiting out the lease. No-op if the record is completed or owned by a
    /// different fingerprint.
    /// </summary>
    Task ReleaseAsync(string scope, string fingerprint, CancellationToken ct);

    /// <summary>Reads the current record for a scope (used by losers polling for a completed result).</summary>
    Task<IdempotencyRecord?> GetAsync(string scope, CancellationToken ct);
}

/// <summary>
/// One-time onboarding reservation keyed by the SHA-256 HASH of the presented token. The raw token
/// is never persisted, never used as a document id / partition key, and never logged. A token hash
/// reserves at most one civilization.
/// </summary>
public interface IOnboardingTokenStore
{
    /// <summary>
    /// Atomically reserves a token (by its hash) for a civ. Returns <c>true</c> on first use,
    /// <c>false</c> if already reserved. <paramref name="tokenHash"/> is a lowercase-hex SHA-256.
    /// </summary>
    Task<bool> TryReserveAsync(string tokenHash, string civId, CancellationToken ct);
}
