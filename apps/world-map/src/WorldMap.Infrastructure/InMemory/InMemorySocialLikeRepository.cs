using WorldMap.Core.Abstractions;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.InMemory;

/// <summary>Thread-safe in-memory canonical like-edge store keyed by the deterministic like doc id.</summary>
public sealed class InMemorySocialLikeRepository : ISocialLikeRepository
{
    private readonly Dictionary<string, SocialLike> _byDoc = new(StringComparer.Ordinal);
    private readonly Lock _gate = new();

    public Task<SocialLike?> GetAsync(string postId, string accountId, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var id = SocialIds.LikeDocId(postId, accountId);
        lock (_gate)
        {
            return Task.FromResult(_byDoc.TryGetValue(id, out var l) ? InMemoryClone.Copy(l) : null);
        }
    }

    public Task<bool> TryUpsertAsync(SocialLike like, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var id = SocialIds.LikeDocId(like.PostId, like.AccountId);
        lock (_gate)
        {
            if (_byDoc.TryGetValue(id, out var stored) && stored.Version >= like.Version)
            {
                return Task.FromResult(false);
            }

            _byDoc[id] = InMemoryClone.Copy(like);
            return Task.FromResult(true);
        }
    }

    public Task<IReadOnlyList<SocialLike>> ListPendingAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            IReadOnlyList<SocialLike> items = _byDoc.Values.Where(l => l.Pending).Select(InMemoryClone.Copy).ToList();
            return Task.FromResult(items);
        }
    }

    public Task<long> CountActiveLikesAsync(string postId, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            return Task.FromResult((long)_byDoc.Values.Count(l => l.PostId == postId && l.Liked));
        }
    }
}
