using WorldMap.Core.Abstractions;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.InMemory;

/// <summary>
/// Thread-safe in-memory world-sequence feed index (global scope + per-author scope).
/// <see cref="AddEntryAsync"/> is idempotent by (scope, postId). Reads are newest-first
/// (worldsequence DESC, postId ASC), bounded by a snapshot high-watermark.
/// </summary>
public sealed class InMemorySocialFeedRepository : ISocialFeedRepository
{
    private readonly List<SocialFeedEntry> _entries = [];
    private readonly HashSet<string> _keys = new(StringComparer.Ordinal);
    private readonly Lock _gate = new();

    private static string Key(string scope, string postId) => $"{scope}\u0000{postId}";

    public Task AddEntryAsync(SocialFeedEntry entry, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            if (_keys.Add(Key(entry.FeedScope, entry.PostId)))
            {
                _entries.Add(InMemoryClone.Copy(entry));
            }

            return Task.CompletedTask;
        }
    }

    public Task<long> MaxWorldsequenceAsync(string feedScope, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            var max = _entries.Where(e => e.FeedScope == feedScope).Select(e => e.Worldsequence).DefaultIfEmpty(0L).Max();
            return Task.FromResult(max);
        }
    }

    public Task<IReadOnlyList<SocialFeedEntry>> ListDescendingAsync(
        string feedScope, long highWatermark, long afterWorldsequence, string afterPostId, int limit, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            IReadOnlyList<SocialFeedEntry> items = _entries
                .Where(e => e.FeedScope == feedScope && Qualifies(e, highWatermark, afterWorldsequence, afterPostId))
                .OrderByDescending(e => e.Worldsequence)
                .ThenBy(e => e.PostId, StringComparer.Ordinal)
                .Take(limit)
                .Select(InMemoryClone.Copy)
                .ToList();

            return Task.FromResult(items);
        }
    }

    public Task<IReadOnlyList<SocialFeedEntry>> ListFollowingDescendingAsync(
        IReadOnlyCollection<string> authorScopes, long highWatermark, long afterWorldsequence, string afterPostId, int limit, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (authorScopes.Count == 0)
        {
            return Task.FromResult<IReadOnlyList<SocialFeedEntry>>([]);
        }

        var scopes = new HashSet<string>(authorScopes, StringComparer.Ordinal);
        lock (_gate)
        {
            IReadOnlyList<SocialFeedEntry> items = _entries
                .Where(e => scopes.Contains(e.FeedScope) && Qualifies(e, highWatermark, afterWorldsequence, afterPostId))
                .OrderByDescending(e => e.Worldsequence)
                .ThenBy(e => e.PostId, StringComparer.Ordinal)
                .Take(limit)
                .Select(InMemoryClone.Copy)
                .ToList();

            return Task.FromResult(items);
        }
    }

    private static bool Qualifies(SocialFeedEntry e, long hw, long afterWs, string afterPostId) =>
        e.Worldsequence <= hw
        && (e.Worldsequence < afterWs
            || (e.Worldsequence == afterWs && string.CompareOrdinal(e.PostId, afterPostId) > 0));
}
