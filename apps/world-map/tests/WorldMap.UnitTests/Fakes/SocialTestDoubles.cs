using System.Text.Json.Nodes;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Contracts;
using WorldMap.Core.Domain;

namespace WorldMap.UnitTests.Fakes;

/// <summary>Records every published public event so tests can assert live SSE (/stream) fan-out.</summary>
public sealed class CapturingWorldEventSink : IWorldEventSink
{
    private readonly List<CloudEventDto> _events = [];
    private readonly Lock _gate = new();

    public IReadOnlyList<CloudEventDto> Captured
    {
        get
        {
            lock (_gate)
            {
                return _events.ToList();
            }
        }
    }

    public void Publish(CloudEventDto publicEvent)
    {
        lock (_gate)
        {
            _events.Add(publicEvent);
        }
    }
}

/// <summary>World-event repo that throws on its first append WITHOUT committing (crash before append).</summary>
internal sealed class ThrowOnceBeforeWorldEventAppend(IWorldEventRepository inner) : IWorldEventRepository
{
    private int _remaining = 1;

    private void MaybeThrow()
    {
        if (Interlocked.Exchange(ref _remaining, 0) == 1)
        {
            throw new InjectedFailureException();
        }
    }

    public Task<WorldEventAppend> AppendAsync(WorldEvent worldEvent, CancellationToken ct)
    {
        MaybeThrow();
        return inner.AppendAsync(worldEvent, ct);
    }

    public Task<WorldEventAppend> AppendAsync(WorldEvent template, Func<long, JsonNode?> buildPublicData, CancellationToken ct)
    {
        MaybeThrow();
        return inner.AppendAsync(template, buildPublicData, ct);
    }

    public Task<WorldEvent?> GetByDedupeAsync(string dedupeKey, CancellationToken ct) => inner.GetByDedupeAsync(dedupeKey, ct);

    public Task<Page<WorldEvent>> ListAsync(long afterSequence, int limit, CancellationToken ct) => inner.ListAsync(afterSequence, limit, ct);
}

/// <summary>
/// Follow repo wrapper that gates the first <c>gate</c> <see cref="GetAsync"/> calls on a barrier, so a
/// test can force two effects to BOTH read the pre-transition state before either flips (a true race).
/// </summary>
internal sealed class GatedSocialFollowRepository(ISocialFollowRepository inner, int gate) : ISocialFollowRepository
{
    private int _arrivals;
    private readonly TaskCompletionSource _allArrived = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource _release = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public Task AllArrived => _allArrived.Task;

    public void Release() => _release.TrySetResult();

    public async Task<SocialFollow?> GetAsync(string followerAccountId, string followedAccountId, CancellationToken ct)
    {
        var n = Interlocked.Increment(ref _arrivals);
        if (n <= gate)
        {
            if (n == gate)
            {
                _allArrived.TrySetResult();
            }

            await _release.Task;
        }

        return await inner.GetAsync(followerAccountId, followedAccountId, ct);
    }

    public Task<bool> TryUpsertAsync(SocialFollow follow, CancellationToken ct) => inner.TryUpsertAsync(follow, ct);
    public Task<IReadOnlyList<SocialFollow>> ListActiveFollowedAsync(string a, CancellationToken ct) => inner.ListActiveFollowedAsync(a, ct);
    public Task<IReadOnlyList<SocialFollow>> ListFollowedDescendingAsync(string a, long hw, long ws, string tie, int limit, CancellationToken ct) => inner.ListFollowedDescendingAsync(a, hw, ws, tie, limit, ct);
    public Task<IReadOnlyList<SocialFollow>> ListFollowersDescendingAsync(string a, long hw, long ws, string tie, int limit, CancellationToken ct) => inner.ListFollowersDescendingAsync(a, hw, ws, tie, limit, ct);
    public Task<long> MaxFollowedWorldsequenceAsync(string a, CancellationToken ct) => inner.MaxFollowedWorldsequenceAsync(a, ct);
    public Task<long> MaxFollowersWorldsequenceAsync(string a, CancellationToken ct) => inner.MaxFollowersWorldsequenceAsync(a, ct);
    public Task<IReadOnlyList<SocialFollow>> ListPendingAsync(CancellationToken ct) => inner.ListPendingAsync(ct);
    public Task<long> CountActiveFollowingAsync(string a, CancellationToken ct) => inner.CountActiveFollowingAsync(a, ct);
    public Task<long> CountActiveFollowersAsync(string a, CancellationToken ct) => inner.CountActiveFollowersAsync(a, ct);
}

/// <summary>Like repo wrapper that gates the first <c>gate</c> <see cref="GetAsync"/> calls (true race).</summary>
internal sealed class GatedSocialLikeRepository(ISocialLikeRepository inner, int gate) : ISocialLikeRepository
{
    private int _arrivals;
    private readonly TaskCompletionSource _allArrived = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource _release = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public Task AllArrived => _allArrived.Task;

    public void Release() => _release.TrySetResult();

    public async Task<SocialLike?> GetAsync(string postId, string accountId, CancellationToken ct)
    {
        var n = Interlocked.Increment(ref _arrivals);
        if (n <= gate)
        {
            if (n == gate)
            {
                _allArrived.TrySetResult();
            }

            await _release.Task;
        }

        return await inner.GetAsync(postId, accountId, ct);
    }

    public Task<bool> TryUpsertAsync(SocialLike like, CancellationToken ct) => inner.TryUpsertAsync(like, ct);
    public Task<IReadOnlyList<SocialLike>> ListPendingAsync(CancellationToken ct) => inner.ListPendingAsync(ct);
    public Task<long> CountActiveLikesAsync(string postId, CancellationToken ct) => inner.CountActiveLikesAsync(postId, ct);
}

/// <summary>Account repo wrapper that throws on the Nth <see cref="TryUpdateAsync"/> (simulate a count-write crash).</summary>
internal sealed class FailOnAccountUpdate(ISocialAccountRepository inner, int throwOnCall) : ISocialAccountRepository
{
    private int _calls;

    public Task<SocialAccount?> GetAsync(string accountId, CancellationToken ct) => inner.GetAsync(accountId, ct);
    public Task UpsertAsync(SocialAccount account, CancellationToken ct) => inner.UpsertAsync(account, ct);
    public Task<SocialListPage<SocialAccount>> ListPageAsync(string? continuation, int limit, CancellationToken ct) => inner.ListPageAsync(continuation, limit, ct);

    public Task<bool> TryUpdateAsync(SocialAccount account, CancellationToken ct)
    {
        if (Interlocked.Increment(ref _calls) == throwOnCall)
        {
            throw new InjectedFailureException();
        }

        return inner.TryUpdateAsync(account, ct);
    }
}

/// <summary>
/// Post repo wrapper that throws when a post is advanced (via <see cref="TryUpdateAsync"/>) to a specific
/// target step — simulating a crash at the step CAS AFTER that step's side effects (e.g. the absolute count
/// writes) have already been applied. Used to prove the repair re-run does not over/under-count.
/// </summary>
internal sealed class FailOnPostStep(ISocialPostRepository inner, WorldMap.Core.Domain.SocialPostStep failAdvancingTo) : ISocialPostRepository
{
    public Task<SocialPost?> GetAsync(string postId, CancellationToken ct) => inner.GetAsync(postId, ct);
    public Task<SocialPost> AddAsync(SocialPost post, CancellationToken ct) => inner.AddAsync(post, ct);
    public Task<IReadOnlyList<SocialPost>> ListThreadAsync(string root, long hw, long ws, string tie, int limit, CancellationToken ct) => inner.ListThreadAsync(root, hw, ws, tie, limit, ct);
    public Task<long> MaxThreadWorldsequenceAsync(string root, CancellationToken ct) => inner.MaxThreadWorldsequenceAsync(root, ct);
    public Task<IReadOnlyList<SocialPost>> ListIncompleteAsync(CancellationToken ct) => inner.ListIncompleteAsync(ct);
    public Task<long> CountByAuthorAsync(string author, CancellationToken ct) => inner.CountByAuthorAsync(author, ct);
    public Task<long> CountRepliesAsync(string parent, CancellationToken ct) => inner.CountRepliesAsync(parent, ct);
    public Task<SocialListPage<SocialPost>> ListPageAsync(string? continuation, int limit, CancellationToken ct) => inner.ListPageAsync(continuation, limit, ct);

    public Task<bool> TryUpdateAsync(SocialPost post, CancellationToken ct)
    {
        if (post.Step == failAdvancingTo)
        {
            throw new InjectedFailureException();
        }

        return inner.TryUpdateAsync(post, ct);
    }
}

/// <summary>Post repo wrapper that throws on the Nth <see cref="TryUpdateAsync"/> (simulate a like-count crash).</summary>
internal sealed class FailOnPostUpdate(ISocialPostRepository inner, int throwOnCall) : ISocialPostRepository
{
    private int _calls;

    public Task<SocialPost?> GetAsync(string postId, CancellationToken ct) => inner.GetAsync(postId, ct);
    public Task<SocialPost> AddAsync(SocialPost post, CancellationToken ct) => inner.AddAsync(post, ct);
    public Task<IReadOnlyList<SocialPost>> ListThreadAsync(string root, long hw, long ws, string tie, int limit, CancellationToken ct) => inner.ListThreadAsync(root, hw, ws, tie, limit, ct);
    public Task<long> MaxThreadWorldsequenceAsync(string root, CancellationToken ct) => inner.MaxThreadWorldsequenceAsync(root, ct);
    public Task<IReadOnlyList<SocialPost>> ListIncompleteAsync(CancellationToken ct) => inner.ListIncompleteAsync(ct);
    public Task<long> CountByAuthorAsync(string author, CancellationToken ct) => inner.CountByAuthorAsync(author, ct);
    public Task<long> CountRepliesAsync(string parent, CancellationToken ct) => inner.CountRepliesAsync(parent, ct);
    public Task<SocialListPage<SocialPost>> ListPageAsync(string? continuation, int limit, CancellationToken ct) => inner.ListPageAsync(continuation, limit, ct);

    public Task<bool> TryUpdateAsync(SocialPost post, CancellationToken ct)
    {
        if (Interlocked.Increment(ref _calls) == throwOnCall)
        {
            throw new InjectedFailureException();
        }

        return inner.TryUpdateAsync(post, ct);
    }
}
