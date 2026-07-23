using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Common;
using WorldMap.Core.Configuration;
using WorldMap.Core.Contracts;
using WorldMap.Core.Domain;

namespace WorldMap.Core.Application.Impl;

/// <summary>
/// World Wire public feeds: the global chronological feed, an account's authored posts, and an account's
/// following feed. All feeds are immutable snapshots ordered newest-first by <c>(worldsequence, postId)</c>;
/// the snapshot high-watermark bounds a traversal so newly created posts never appear mid-page. The
/// following feed additionally freezes the followed-account set in a durable TTL snapshot so follow/unfollow
/// during a traversal cannot reorder or duplicate later pages.
/// </summary>
public sealed class SocialFeedService(
    ISocialAccountRepository accounts,
    ISocialPostRepository posts,
    ISocialFollowRepository follows,
    ISocialFeedRepository feed,
    ISocialSnapshotStore snapshots,
    TimeProvider clock,
    IOptions<WorldMapOptions> options) : ISocialFeedService
{
    private readonly SocialOptions _social = options.Value.Social;

    public async Task<Result<SocialPostPageDto>> GlobalAsync(string? cursor, int? limit, CancellationToken ct)
    {
        var binding = new SocialCursorBinding(SocialFeedEndpoints.GlobalFeed, string.Empty, string.Empty, SocialFeedEndpoints.DescDirection);
        if (!SocialCursors.TryResolve(cursor, binding, out var state))
        {
            return CursorMismatch();
        }

        var take = _social.ClampPageLimit(limit);
        var hw = state?.HighWatermark ?? await feed.MaxWorldsequenceAsync(SocialFeedEntry.GlobalScope, ct);
        var afterWs = state?.PositionWorldsequence ?? SocialCursors.DescStartWorldsequence;
        var afterTie = state?.PositionTieId ?? string.Empty;

        var entries = await feed.ListDescendingAsync(SocialFeedEntry.GlobalScope, hw, afterWs, afterTie, take, ct);
        return await BuildPageAsync(entries, binding, hw, take, snapshotId: null, ct);
    }

    public async Task<Result<SocialPostPageDto>> AccountPostsAsync(string accountId, string? cursor, int? limit, CancellationToken ct)
    {
        if (await accounts.GetAsync(accountId, ct) is null)
        {
            return ErrorResult.Create(ErrorCode.SocialAccountNotFound, $"Social account '{accountId}' is unknown.");
        }

        var binding = new SocialCursorBinding(SocialFeedEndpoints.AccountPosts, accountId, string.Empty, SocialFeedEndpoints.DescDirection);
        if (!SocialCursors.TryResolve(cursor, binding, out var state))
        {
            return CursorMismatch();
        }

        var take = _social.ClampPageLimit(limit);
        var hw = state?.HighWatermark ?? await feed.MaxWorldsequenceAsync(accountId, ct);
        var afterWs = state?.PositionWorldsequence ?? SocialCursors.DescStartWorldsequence;
        var afterTie = state?.PositionTieId ?? string.Empty;

        var entries = await feed.ListDescendingAsync(accountId, hw, afterWs, afterTie, take, ct);
        return await BuildPageAsync(entries, binding, hw, take, snapshotId: null, ct);
    }

    public async Task<Result<SocialPostPageDto>> FollowingFeedAsync(string accountId, string? cursor, int? limit, CancellationToken ct)
    {
        if (await accounts.GetAsync(accountId, ct) is null)
        {
            return ErrorResult.Create(ErrorCode.SocialAccountNotFound, $"Social account '{accountId}' is unknown.");
        }

        var binding = new SocialCursorBinding(SocialFeedEndpoints.FollowingFeed, accountId, string.Empty, SocialFeedEndpoints.DescDirection);
        if (!SocialCursors.TryResolve(cursor, binding, out var state))
        {
            return CursorMismatch();
        }

        var take = _social.ClampPageLimit(limit);
        var now = clock.GetUtcNow();

        long hw;
        string snapshotId;
        IReadOnlyList<string> followedIds;

        if (state is null)
        {
            // First page: freeze the followed-account set and high-watermark in a durable TTL snapshot.
            hw = await feed.MaxWorldsequenceAsync(SocialFeedEntry.GlobalScope, ct);
            followedIds = (await follows.ListActiveFollowedAsync(accountId, ct)).Select(f => f.FollowedAccountId).ToList();
            snapshotId = SocialIds.SnapshotId(accountId, hw);
            await snapshots.UpsertAsync(new SocialSnapshot
            {
                SnapshotId = snapshotId,
                OwnerAccountId = accountId,
                Kind = SocialSnapshot.FollowingFeedKind,
                HighWatermark = hw,
                FollowedAccountIds = followedIds,
                CreatedAt = now,
                ExpiresAt = now.AddSeconds(_social.SnapshotTtlSeconds),
            }, ct);
        }
        else
        {
            // Subsequent page: the snapshot must still exist and be unexpired, else the cursor is stale.
            var snapshot = state.SnapshotId is null ? null : await snapshots.GetAsync(state.SnapshotId, ct);
            if (snapshot is null || snapshot.OwnerAccountId != accountId || snapshot.ExpiresAt <= now)
            {
                return CursorMismatch();
            }

            hw = snapshot.HighWatermark;
            snapshotId = snapshot.SnapshotId;
            followedIds = snapshot.FollowedAccountIds;
        }

        var afterWs = state?.PositionWorldsequence ?? SocialCursors.DescStartWorldsequence;
        var afterTie = state?.PositionTieId ?? string.Empty;

        var entries = await feed.ListFollowingDescendingAsync(followedIds, hw, afterWs, afterTie, take, ct);
        return await BuildPageAsync(entries, binding, hw, take, snapshotId, ct);
    }

    private async Task<Result<SocialPostPageDto>> BuildPageAsync(
        IReadOnlyList<SocialFeedEntry> entries, SocialCursorBinding binding, long hw, int take, string? snapshotId, CancellationToken ct)
    {
        var items = new List<SocialPostDto>(entries.Count);
        var summaries = new Dictionary<string, SocialAccountSummaryDto>(StringComparer.Ordinal);
        foreach (var entry in entries)
        {
            var post = await posts.GetAsync(entry.PostId, ct);
            if (post is null)
            {
                continue;
            }

            if (!summaries.TryGetValue(post.AuthorAccountId, out var summary))
            {
                var account = await accounts.GetAsync(post.AuthorAccountId, ct);
                if (account is null)
                {
                    continue;
                }

                summary = account.ToSummary();
                summaries[post.AuthorAccountId] = summary;
            }

            items.Add(post.ToDto(summary));
        }

        string? next = entries.Count == take && entries.Count > 0
            ? SocialCursors.Encode(binding, hw, entries[^1].Worldsequence, entries[^1].PostId, snapshotId)
            : null;

        return new SocialPostPageDto { Items = items, NextCursor = next };
    }

    private static ErrorInfo CursorMismatch() =>
        ErrorResult.Create(ErrorCode.CursorFilterMismatch, "The cursor was used with a different endpoint, account, or filter.");
}
