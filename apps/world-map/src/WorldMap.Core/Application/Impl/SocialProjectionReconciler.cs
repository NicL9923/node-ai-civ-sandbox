using Microsoft.Extensions.Logging;
using WorldMap.Core.Abstractions;

namespace WorldMap.Core.Application.Impl;

/// <summary>
/// Recomputes the eventually-consistent social count projections to their ABSOLUTE values from canonical
/// state (active follower/following edges, posts by author, replies, active likes) and writes them back
/// with optimistic concurrency. Because the writes are absolute (not increments), reconciliation is
/// idempotent and converges after ANY crash — including a crash between clearing an edge's pending marker
/// and its inline count write, which the transition/repair path alone cannot see. Work is paged and
/// bounded per sweep, cycling through all accounts/posts over successive sweeps.
/// </summary>
public sealed class SocialProjectionReconciler(
    ISocialAccountRepository accounts,
    ISocialPostRepository posts,
    ISocialFollowRepository follows,
    ISocialLikeRepository likes,
    ILogger<SocialProjectionReconciler> logger) : ISocialProjectionReconciler
{
    private const int PageSize = 200;
    private const int MaxConcurrencyRetries = 8;

    private readonly Lock _gate = new();
    private string? _accountCursor;
    private string? _postCursor;

    public async Task ReconcileAsync(CancellationToken ct)
    {
        var accountCursor = Read(ref _accountCursor);
        var accountPage = await accounts.ListPageAsync(accountCursor, PageSize, ct);
        foreach (var account in accountPage.Items)
        {
            var followers = await follows.CountActiveFollowersAsync(account.AccountId, ct);
            var following = await follows.CountActiveFollowingAsync(account.AccountId, ct);
            var postCount = await posts.CountByAuthorAsync(account.AccountId, ct);
            if (account.FollowerCount != followers || account.FollowingCount != following || account.PostCount != postCount)
            {
                await SetAccountCountsAsync(account.AccountId, followers, following, postCount, ct);
            }
        }

        Write(ref _accountCursor, accountPage.Continuation);

        var postCursor = Read(ref _postCursor);
        var postPage = await posts.ListPageAsync(postCursor, PageSize, ct);
        foreach (var post in postPage.Items)
        {
            var replies = await posts.CountRepliesAsync(post.PostId, ct);
            var likeCount = await likes.CountActiveLikesAsync(post.PostId, ct);
            if (post.ReplyCount != replies || post.LikeCount != likeCount)
            {
                await SetPostCountsAsync(post.PostId, replies, likeCount, ct);
            }
        }

        Write(ref _postCursor, postPage.Continuation);
    }

    private async Task SetAccountCountsAsync(string accountId, long followers, long following, long postCount, CancellationToken ct)
    {
        for (var attempt = 0; attempt < MaxConcurrencyRetries; attempt++)
        {
            var account = await accounts.GetAsync(accountId, ct);
            if (account is null)
            {
                return;
            }

            if (account.FollowerCount == followers && account.FollowingCount == following && account.PostCount == postCount)
            {
                return; // Already converged (idempotent).
            }

            account.FollowerCount = followers;
            account.FollowingCount = following;
            account.PostCount = postCount;
            account.Version++;
            if (await accounts.TryUpdateAsync(account, ct))
            {
                return;
            }
        }

        logger.LogDebug("Account count reconciliation for {AccountId} lost contention; a later sweep will retry.", accountId);
    }

    private async Task SetPostCountsAsync(string postId, long replies, long likeCount, CancellationToken ct)
    {
        for (var attempt = 0; attempt < MaxConcurrencyRetries; attempt++)
        {
            var post = await posts.GetAsync(postId, ct);
            if (post is null)
            {
                return;
            }

            if (post.ReplyCount == replies && post.LikeCount == likeCount)
            {
                return;
            }

            post.ReplyCount = replies;
            post.LikeCount = likeCount;
            post.Version++;
            if (await posts.TryUpdateAsync(post, ct))
            {
                return;
            }
        }

        logger.LogDebug("Post count reconciliation for {PostId} lost contention; a later sweep will retry.", postId);
    }

    private string? Read(ref string? cursor)
    {
        lock (_gate)
        {
            return cursor;
        }
    }

    private void Write(ref string? cursor, string? value)
    {
        lock (_gate)
        {
            cursor = value; // null continuation ⇒ the next sweep restarts from the beginning (cycles).
        }
    }
}
