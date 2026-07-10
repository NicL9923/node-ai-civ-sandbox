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
/// Single-use nonce store for HMAC replay protection, scoped per signing key within the
/// replay window. Backed by TTL in Cosmos; swept in memory.
/// </summary>
public interface INonceStore
{
    /// <summary>
    /// Atomically records a nonce for a key. Returns <c>true</c> if the nonce was unused
    /// (accept), <c>false</c> if it was already seen within the window (replay).
    /// </summary>
    Task<bool> TryConsumeAsync(string keyId, string nonce, DateTimeOffset expiresAt, CancellationToken ct);
}

/// <summary>
/// Idempotency store for mutating operations. Returns the original stored result on
/// replay of the same key so effects happen at-most-once.
/// </summary>
public interface IIdempotencyStore
{
    Task<IdempotencyRecord?> GetAsync(string scope, CancellationToken ct);

    /// <summary>
    /// Stores the original result for a scope. Returns the record that now owns the scope:
    /// the newly stored one, or a pre-existing one if a concurrent writer won the race.
    /// </summary>
    Task<IdempotencyRecord> PutIfAbsentAsync(IdempotencyRecord record, CancellationToken ct);
}

/// <summary>
/// One-time onboarding token store. Tokens are provisioned out-of-band (config); this
/// tracks consumption so a token registers at most one civilization.
/// </summary>
public interface IOnboardingTokenStore
{
    /// <summary>Atomically marks a configured token consumed. Returns false if already used.</summary>
    Task<bool> TryConsumeAsync(string token, string civId, CancellationToken ct);
}
