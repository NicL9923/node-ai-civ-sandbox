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
}
