using WorldMap.Core.Abstractions;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.InMemory;

/// <summary>
/// Thread-safe in-memory canonical post store keyed by post id. <see cref="AddAsync"/> is idempotent by
/// the deterministic post id (returns the existing post on a retry); <see cref="TryUpdateAsync"/> is a
/// monotonic-version CAS. Thread reads are ordered (worldsequence ASC, postId ASC) and bounded by a
/// snapshot high-watermark.
/// </summary>
public sealed class InMemorySocialPostRepository : ISocialPostRepository
{
    private readonly Dictionary<string, SocialPost> _byId = new(StringComparer.Ordinal);
    private readonly Lock _gate = new();
    private long _sequence;

    public Task<SocialPost?> GetAsync(string postId, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            return Task.FromResult(_byId.TryGetValue(postId, out var p) ? InMemoryClone.Copy(p) : null);
        }
    }

    public Task<SocialPost> AddAsync(SocialPost post, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            if (_byId.TryGetValue(post.PostId, out var existing))
            {
                return Task.FromResult(InMemoryClone.Copy(existing));
            }

            var stored = InMemoryClone.Copy(post);
            if (stored.Worldsequence <= 0)
            {
                // Allocate-through-insert: the post's creation worldsequence is committed with the record.
                stored.Worldsequence = ++_sequence;
            }

            _byId[post.PostId] = stored;
            return Task.FromResult(InMemoryClone.Copy(stored));
        }
    }

    public Task<bool> TryUpdateAsync(SocialPost post, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            if (!_byId.TryGetValue(post.PostId, out var stored) || stored.Version >= post.Version)
            {
                return Task.FromResult(false);
            }

            _byId[post.PostId] = InMemoryClone.Copy(post);
            return Task.FromResult(true);
        }
    }

    public Task<IReadOnlyList<SocialPost>> ListThreadAsync(
        string conversationRootPostId, long highWatermark, long afterWorldsequence, string afterPostId, int limit, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            IReadOnlyList<SocialPost> items = _byId.Values
                .Where(p => p.ConversationRootPostId == conversationRootPostId
                    && p.Worldsequence <= highWatermark
                    && (p.Worldsequence > afterWorldsequence
                        || (p.Worldsequence == afterWorldsequence && string.CompareOrdinal(p.PostId, afterPostId) > 0)))
                .OrderBy(p => p.Worldsequence)
                .ThenBy(p => p.PostId, StringComparer.Ordinal)
                .Take(limit)
                .Select(InMemoryClone.Copy)
                .ToList();

            return Task.FromResult(items);
        }
    }

    public Task<IReadOnlyList<SocialPost>> ListIncompleteAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            IReadOnlyList<SocialPost> items = _byId.Values
                .Where(p => p.Step != SocialPostStep.Done)
                .Select(InMemoryClone.Copy)
                .ToList();

            return Task.FromResult(items);
        }
    }

    public Task<long> MaxThreadWorldsequenceAsync(string conversationRootPostId, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            var max = _byId.Values
                .Where(p => p.ConversationRootPostId == conversationRootPostId)
                .Select(p => p.Worldsequence)
                .DefaultIfEmpty(0L)
                .Max();
            return Task.FromResult(max);
        }
    }
}
