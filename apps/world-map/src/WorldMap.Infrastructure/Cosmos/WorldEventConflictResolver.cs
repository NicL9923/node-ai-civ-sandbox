using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.Cosmos;

/// <summary>How a world-event create conflict (HTTP 409) was resolved by observing the store.</summary>
internal enum WorldEventConflictKind
{
    /// <summary>Our own dedupe/identity record is already committed (idempotent replay).</summary>
    Duplicate,

    /// <summary>A DIFFERENT event already occupies the proposed <c>worldsequence</c> (unique-key violation).</summary>
    Occupied,

    /// <summary>Neither conflict was observed within the bounded window; the caller must retry/reseed.</summary>
    Unresolved,
}

/// <summary>The observed resolution of a create conflict.</summary>
/// <param name="Kind">Which conflict was observed.</param>
/// <param name="Existing">The committed event for a <see cref="WorldEventConflictKind.Duplicate"/>; otherwise null.</param>
internal readonly record struct WorldEventConflictResolution(WorldEventConflictKind Kind, WorldEvent? Existing);

/// <summary>
/// Resolves a world-event insert <c>409 Conflict</c> by OBSERVING which conflicting document exists rather
/// than guessing from a single (possibly stale) read. A 409 proves exactly one of two conflicts occurred:
/// our own dedupe/id record already committed, OR a different event already holds the proposed
/// <c>worldsequence</c> (rejected by the <c>/payload/worldsequence</c> unique key). Under Session/Eventual
/// consistency the conflicting doc may not be immediately visible, so this polls both with bounded,
/// jittered backoff and honours cancellation. If neither becomes visible in the window it reports
/// <see cref="WorldEventConflictKind.Unresolved"/> so the caller throws a retryable error and reseeds —
/// never guessing a duplicate nor blindly allocating a different sequence.
/// </summary>
internal static class WorldEventConflictResolver
{
    public static async Task<WorldEventConflictResolution> ResolveAsync(
        Func<CancellationToken, Task<WorldEvent?>> readOwnById,
        Func<CancellationToken, Task<WorldEvent?>> readOwnerBySequence,
        int maxAttempts,
        Func<int, CancellationToken, Task> delay,
        CancellationToken ct)
    {
        for (var attempt = 0; attempt < maxAttempts; attempt++)
        {
            ct.ThrowIfCancellationRequested();

            // Prefer our own committed record: if it exists, our event is durably present with its ORIGINAL
            // sequence and the proposal is released (no sequence consumed by this attempt).
            var mine = await readOwnById(ct).ConfigureAwait(false);
            if (mine is not null)
            {
                return new WorldEventConflictResolution(WorldEventConflictKind.Duplicate, mine);
            }

            // Otherwise the unique key rejected us because a DIFFERENT event owns the proposed sequence.
            var owner = await readOwnerBySequence(ct).ConfigureAwait(false);
            if (owner is not null)
            {
                return new WorldEventConflictResolution(WorldEventConflictKind.Occupied, null);
            }

            if (attempt < maxAttempts - 1)
            {
                await delay(attempt, ct).ConfigureAwait(false);
            }
        }

        return new WorldEventConflictResolution(WorldEventConflictKind.Unresolved, null);
    }
}

/// <summary>
/// A world-event create returned 409 but neither the same-dedupe record nor the sequence owner became
/// visible within the bounded observation window. Retryable: the allocator seed is invalidated so a later
/// attempt reseeds from the persisted counter + live MAX and re-resolves once replication catches up.
/// </summary>
public sealed class WorldEventConflictUnresolvedException(long proposedWorldsequence)
    : Exception($"World-event create conflicted at worldsequence {proposedWorldsequence} but the conflicting document was not yet observable; retry.")
{
    public long ProposedWorldsequence { get; } = proposedWorldsequence;
}
