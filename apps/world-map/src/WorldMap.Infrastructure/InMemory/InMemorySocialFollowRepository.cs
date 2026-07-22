using WorldMap.Core.Abstractions;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.InMemory;

/// <summary>
/// Thread-safe in-memory canonical following-edge store keyed by the deterministic follow doc id.
/// <see cref="TryUpsertAsync"/> is a monotonic-version CAS. List reads return active (following=true)
/// edges newest-first by edge worldsequence, bounded by a snapshot high-watermark.
/// </summary>
public sealed class InMemorySocialFollowRepository : ISocialFollowRepository
{
    private readonly Dictionary<string, SocialFollow> _byDoc = new(StringComparer.Ordinal);
    private readonly Lock _gate = new();

    public Task<SocialFollow?> GetAsync(string followerAccountId, string followedAccountId, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var id = SocialIds.FollowDocId(followerAccountId, followedAccountId);
        lock (_gate)
        {
            return Task.FromResult(_byDoc.TryGetValue(id, out var f) ? InMemoryClone.Copy(f) : null);
        }
    }

    public Task<bool> TryUpsertAsync(SocialFollow follow, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var id = SocialIds.FollowDocId(follow.FollowerAccountId, follow.FollowedAccountId);
        lock (_gate)
        {
            if (_byDoc.TryGetValue(id, out var stored) && stored.Version >= follow.Version)
            {
                return Task.FromResult(false);
            }

            _byDoc[id] = InMemoryClone.Copy(follow);
            return Task.FromResult(true);
        }
    }

    public Task<IReadOnlyList<SocialFollow>> ListActiveFollowedAsync(string followerAccountId, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            IReadOnlyList<SocialFollow> items = _byDoc.Values
                .Where(f => f.FollowerAccountId == followerAccountId && f.Following)
                .Select(InMemoryClone.Copy)
                .ToList();

            return Task.FromResult(items);
        }
    }

    public Task<IReadOnlyList<SocialFollow>> ListFollowedDescendingAsync(
        string followerAccountId, long highWatermark, long afterWorldsequence, string afterTieId, int limit, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            IReadOnlyList<SocialFollow> items = _byDoc.Values
                .Where(f => f.FollowerAccountId == followerAccountId && f.Following
                    && f.Worldsequence <= highWatermark
                    && (f.Worldsequence < afterWorldsequence
                        || (f.Worldsequence == afterWorldsequence && string.CompareOrdinal(f.FollowedAccountId, afterTieId) > 0)))
                .OrderByDescending(f => f.Worldsequence)
                .ThenBy(f => f.FollowedAccountId, StringComparer.Ordinal)
                .Take(limit)
                .Select(InMemoryClone.Copy)
                .ToList();

            return Task.FromResult(items);
        }
    }

    public Task<IReadOnlyList<SocialFollow>> ListFollowersDescendingAsync(
        string followedAccountId, long highWatermark, long afterWorldsequence, string afterTieId, int limit, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            IReadOnlyList<SocialFollow> items = _byDoc.Values
                .Where(f => f.FollowedAccountId == followedAccountId && f.Following
                    && f.Worldsequence <= highWatermark
                    && (f.Worldsequence < afterWorldsequence
                        || (f.Worldsequence == afterWorldsequence && string.CompareOrdinal(f.FollowerAccountId, afterTieId) > 0)))
                .OrderByDescending(f => f.Worldsequence)
                .ThenBy(f => f.FollowerAccountId, StringComparer.Ordinal)
                .Take(limit)
                .Select(InMemoryClone.Copy)
                .ToList();

            return Task.FromResult(items);
        }
    }

    public Task<long> MaxFollowedWorldsequenceAsync(string followerAccountId, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            var max = _byDoc.Values
                .Where(f => f.FollowerAccountId == followerAccountId && f.Following)
                .Select(f => f.Worldsequence)
                .DefaultIfEmpty(0L)
                .Max();
            return Task.FromResult(max);
        }
    }

    public Task<long> MaxFollowersWorldsequenceAsync(string followedAccountId, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            var max = _byDoc.Values
                .Where(f => f.FollowedAccountId == followedAccountId && f.Following)
                .Select(f => f.Worldsequence)
                .DefaultIfEmpty(0L)
                .Max();
            return Task.FromResult(max);
        }
    }
}
