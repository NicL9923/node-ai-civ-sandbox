using System.Collections.Concurrent;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.InMemory;

/// <summary>
/// Thread-safe in-memory onboarding registration ledger, keyed by the token HASH (never the raw
/// token). Records (civ + canonical fingerprint) on first use; a later same-fingerprint request is a
/// replay (do not mutate the civ) and a different fingerprint is a conflict.
/// </summary>
public sealed class InMemoryOnboardingTokenStore : IOnboardingTokenStore
{
    private readonly ConcurrentDictionary<string, (string CivId, string Fingerprint)> _reserved = new(StringComparer.Ordinal);

    public Task<OnboardingReservationOutcome> ReserveAsync(string tokenHash, string civId, string fingerprint, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        // Atomic first-writer-wins: TryAdd tells us whether this call created the reservation.
        if (_reserved.TryAdd(tokenHash, (civId, fingerprint)))
        {
            return Task.FromResult(OnboardingReservationOutcome.Reserved);
        }

        var existing = _reserved[tokenHash];
        var outcome = existing.Fingerprint == fingerprint
            ? OnboardingReservationOutcome.DuplicateMatch
            : OnboardingReservationOutcome.Conflict;
        return Task.FromResult(outcome);
    }
}
