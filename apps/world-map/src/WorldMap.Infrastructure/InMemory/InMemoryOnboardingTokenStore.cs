using System.Collections.Concurrent;
using WorldMap.Core.Abstractions;

namespace WorldMap.Infrastructure.InMemory;

/// <summary>
/// Thread-safe in-memory one-time onboarding reservation, keyed by the token HASH (never the raw
/// token). Idempotent for the same civ so a resumed registration re-reserves without burning the
/// token; a reservation for a different civ is rejected.
/// </summary>
public sealed class InMemoryOnboardingTokenStore : IOnboardingTokenStore
{
    private readonly ConcurrentDictionary<string, string> _reserved = new(StringComparer.Ordinal);

    public Task<bool> TryReserveAsync(string tokenHash, string civId, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var owner = _reserved.GetOrAdd(tokenHash, civId);
        return Task.FromResult(owner == civId);
    }
}
