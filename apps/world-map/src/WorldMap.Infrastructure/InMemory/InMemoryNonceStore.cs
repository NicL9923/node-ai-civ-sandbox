using System.Collections.Concurrent;
using WorldMap.Core.Abstractions;

namespace WorldMap.Infrastructure.InMemory;

/// <summary>
/// In-memory single-use nonce store for HMAC replay protection. A nonce is accepted once
/// per <c>keyId</c> within its window; a repeat before expiry is a replay. Expired entries
/// are pruned opportunistically so the map does not grow unbounded.
/// </summary>
public sealed class InMemoryNonceStore : INonceStore
{
    private const int PruneThreshold = 1024;

    private readonly ConcurrentDictionary<string, DateTimeOffset> _seen = new(StringComparer.Ordinal);
    private readonly Lock _gate = new();

    public Task<bool> TryConsumeAsync(string keyId, string nonce, DateTimeOffset expiresAt, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var now = DateTimeOffset.UtcNow;
        var key = $"{keyId}|{nonce}";

        lock (_gate)
        {
            // Replay only if a still-valid entry exists. An expired entry is treated as fresh.
            if (_seen.TryGetValue(key, out var existingExpiry) && existingExpiry > now)
            {
                return Task.FromResult(false);
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
