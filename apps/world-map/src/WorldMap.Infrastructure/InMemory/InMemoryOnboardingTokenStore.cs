using System.Collections.Concurrent;
using WorldMap.Core.Abstractions;

namespace WorldMap.Infrastructure.InMemory;

/// <summary>
/// In-memory one-time onboarding token consumption tracker. The onboarding service validates
/// the token against the provisioned records; this store only guarantees a token binds at most
/// one civilization (atomic first-writer-wins).
/// </summary>
public sealed class InMemoryOnboardingTokenStore : IOnboardingTokenStore
{
    private readonly ConcurrentDictionary<string, string> _consumed = new(StringComparer.Ordinal);

    public Task<bool> TryConsumeAsync(string token, string civId, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        // TryAdd is atomic: exactly one civ wins the token.
        return Task.FromResult(_consumed.TryAdd(token, civId));
    }
}
