using System.Collections.Concurrent;
using WorldMap.Core.Abstractions;

namespace WorldMap.Infrastructure.InMemory;

/// <summary>
/// Thread-safe in-memory nonce store for HMAC replay protection, scoped by <c>civId + keyId + nonce</c>.
/// A nonce is accepted once within its window; its expiry is derived from the signed timestamp by the
/// caller. Two civs may independently use the same <c>keyId</c>+<c>nonce</c> without collision.
/// </summary>
public sealed class InMemoryNonceStore : INonceStore
{
    private const int PruneThreshold = 1024;

    private readonly ConcurrentDictionary<string, DateTimeOffset> _seen = new(StringComparer.Ordinal);
    private readonly Lock _gate = new();

    public Task<bool> TryConsumeAsync(string civId, string keyId, string nonce, DateTimeOffset expiresAt, DateTimeOffset now, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var key = $"{civId}|{keyId}|{nonce}";

        lock (_gate)
        {
            if (_seen.TryGetValue(key, out var existingExpiry) && existingExpiry > now)
            {
                return Task.FromResult(false); // Replay within the window.
            }

            _seen[key] = expiresAt;
        }

        MaybePrune(now);
        return Task.FromResult(true);
    }

    private void MaybePrune(DateTimeOffset now)
    {
        if (_seen.Count < PruneThreshold)
        {
            return;
        }

        foreach (var pair in _seen)
        {
            if (pair.Value <= now)
            {
                _seen.TryRemove(pair.Key, out _);
            }
        }
    }
}
