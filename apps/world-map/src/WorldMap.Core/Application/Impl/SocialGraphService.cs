using WorldMap.Core.Abstractions;
using WorldMap.Core.Common;
using WorldMap.Core.Contracts;
using WorldMap.Core.Domain;

namespace WorldMap.Core.Application.Impl;

/// <summary>
/// World Wire desired-state follow and like mutations. Canonical edge sets are World-owned and
/// single-writer; applying an already-current state succeeds with <c>changed:false</c> and never inverts
/// or emits an event. Self-follow is forbidden; self-like is allowed. A state-change event is emitted only
/// when the canonical state actually changed. Projected counts and feeds are eventually consistent.
/// </summary>
public sealed class SocialGraphService(
    ISocialAccountRepository accounts,
    ISocialPostRepository posts,
    ISocialFollowRepository follows,
    ISocialLikeRepository likes,
    IWorldEventRepository worldEvents,
    SocialMutationPipeline pipeline,
    SocialEventFactory eventFactory,
    IWorldEventSink sink,
    TimeProvider clock) : ISocialGraphService
{
    private const int MaxConcurrencyRetries = 8;

    public async Task<Result<SocialMutationEnvelope<SocialFollowDto>>> SetFollowAsync(
        string authenticatedCivId, string accountId, string targetAccountId, SocialFollowSetRequestDto request, string idempotencyKey, CancellationToken ct)
    {
        if (string.Equals(accountId, targetAccountId, StringComparison.Ordinal))
        {
            return ErrorResult.Create(ErrorCode.SelfFollowForbidden, "An account cannot follow itself.");
        }

        var actor = await accounts.GetAsync(accountId, ct);
        var authz = SocialAuthorization.Authorize(actor, accountId, authenticatedCivId, request.Authorization);
        if (!authz.IsSuccess)
        {
            return authz.Error;
        }

        var target = await accounts.GetAsync(targetAccountId, ct);
        if (target is null)
        {
            return ErrorResult.Create(ErrorCode.SocialAccountNotFound, $"Social account '{targetAccountId}' is unknown.");
        }

        var scope = $"social:follow:{authenticatedCivId}:{idempotencyKey}";
        var fingerprint = RequestFingerprint.Of(request);

        return await pipeline.RunAsync<SocialFollowDto>(
            scope,
            fingerprint,
            accountId,
            SocialQuota.Follow,
            innerCt => FollowEffectAsync(accountId, targetAccountId, request.Following, scope, innerCt),
            ct);
    }

    private async Task<Result<OperationOutcome<SocialFollowDto>>> FollowEffectAsync(
        string followerAccountId, string followedAccountId, bool desired, string scope, CancellationToken ct)
    {
        for (var attempt = 0; attempt < MaxConcurrencyRetries; attempt++)
        {
            var now = clock.GetUtcNow();
            var edge = await follows.GetAsync(followerAccountId, followedAccountId, ct);
            var current = edge?.Following ?? false;
            var changed = current != desired;

            if (!changed)
            {
                var dto = new SocialFollowDto
                {
                    FollowerAccountId = followerAccountId,
                    FollowedAccountId = followedAccountId,
                    Following = current,
                    Changed = false,
                    UpdatedAt = edge?.UpdatedAt ?? now,
                    Worldsequence = (edge?.Worldsequence ?? 0).ToString(),
                };
                return new OperationOutcome<SocialFollowDto>(dto, 200, null);
            }

            // A state change emits exactly one public event; its envelope worldsequence orders the edge.
            var dedupe = SocialIds.EventDedupe("follow-changed", scope);
            var append = await worldEvents.AppendAsync(new WorldEvent
            {
                EventId = SocialIds.EventId(dedupe),
                Type = desired ? SocialEventTypes.AccountFollowed : SocialEventTypes.AccountUnfollowed,
                Source = SocialEventTypes.Source,
                Subject = followedAccountId,
                Time = now,
                PublicData = eventFactory.FollowChanged(new SocialFollowChangedEventDataDto
                {
                    FollowerAccountId = followerAccountId,
                    FollowedAccountId = followedAccountId,
                    Following = desired,
                    ChangedAt = now,
                }),
                DedupeKey = dedupe,
                CreatedAt = now,
            }, ct);
            var worldsequence = append.Event.Worldsequence;

            edge ??= new SocialFollow { FollowerAccountId = followerAccountId, FollowedAccountId = followedAccountId };
            edge.Following = desired;
            edge.UpdatedAt = now;
            edge.Worldsequence = worldsequence;
            edge.Version++;
            if (!await follows.TryUpsertAsync(edge, ct))
            {
                continue; // Concurrent writer — reload and retry.
            }

            if (!append.WasDuplicate)
            {
                sink.Publish(append.Event.ToPublicDto());
            }

            // Eventually-consistent counts.
            await AdjustAccountAsync(followerAccountId, a => a.FollowingCount = Bump(a.FollowingCount, desired), ct);
            await AdjustAccountAsync(followedAccountId, a => a.FollowerCount = Bump(a.FollowerCount, desired), ct);

            var result = new SocialFollowDto
            {
                FollowerAccountId = followerAccountId,
                FollowedAccountId = followedAccountId,
                Following = desired,
                Changed = true,
                UpdatedAt = now,
                Worldsequence = worldsequence.ToString(),
            };
            return new OperationOutcome<SocialFollowDto>(result, 200, null);
        }

        return ErrorResult.Create(ErrorCode.ConcurrencyConflict, "The follow could not be applied due to contention; retry.", retryable: true);
    }

    public async Task<Result<SocialMutationEnvelope<SocialReactionDto>>> SetLikeAsync(
        string authenticatedCivId, string postId, string accountId, SocialReactionSetRequestDto request, string idempotencyKey, CancellationToken ct)
    {
        var post = await posts.GetAsync(postId, ct);
        if (post is null)
        {
            return ErrorResult.Create(ErrorCode.PostNotFound, $"Post '{postId}' is unknown.");
        }

        var actor = await accounts.GetAsync(accountId, ct);
        var authz = SocialAuthorization.Authorize(actor, accountId, authenticatedCivId, request.Authorization);
        if (!authz.IsSuccess)
        {
            return authz.Error;
        }

        var scope = $"social:like:{authenticatedCivId}:{idempotencyKey}";
        var fingerprint = RequestFingerprint.Of(request);

        return await pipeline.RunAsync<SocialReactionDto>(
            scope,
            fingerprint,
            accountId,
            SocialQuota.Reaction,
            innerCt => LikeEffectAsync(postId, accountId, request.Liked, scope, innerCt),
            ct);
    }

    private async Task<Result<OperationOutcome<SocialReactionDto>>> LikeEffectAsync(
        string postId, string accountId, bool desired, string scope, CancellationToken ct)
    {
        for (var attempt = 0; attempt < MaxConcurrencyRetries; attempt++)
        {
            var now = clock.GetUtcNow();
            var edge = await likes.GetAsync(postId, accountId, ct);
            var current = edge?.Liked ?? false;
            var changed = current != desired;

            if (!changed)
            {
                var post = await posts.GetAsync(postId, ct);
                var dto = new SocialReactionDto
                {
                    PostId = postId,
                    AccountId = accountId,
                    Liked = current,
                    Changed = false,
                    LikeCount = post?.LikeCount ?? 0,
                    UpdatedAt = edge?.UpdatedAt ?? now,
                    Worldsequence = (edge?.Worldsequence ?? 0).ToString(),
                };
                return new OperationOutcome<SocialReactionDto>(dto, 200, null);
            }

            var dedupe = SocialIds.EventDedupe("reaction-changed", scope);
            var append = await worldEvents.AppendAsync(new WorldEvent
            {
                EventId = SocialIds.EventId(dedupe),
                Type = desired ? SocialEventTypes.PostLiked : SocialEventTypes.PostUnliked,
                Source = SocialEventTypes.Source,
                Subject = postId,
                Time = now,
                PublicData = eventFactory.ReactionChanged(new SocialPostReactionChangedEventDataDto
                {
                    PostId = postId,
                    AccountId = accountId,
                    Liked = desired,
                    ChangedAt = now,
                }),
                DedupeKey = dedupe,
                CreatedAt = now,
            }, ct);
            var worldsequence = append.Event.Worldsequence;

            edge ??= new SocialLike { PostId = postId, AccountId = accountId };
            edge.Liked = desired;
            edge.UpdatedAt = now;
            edge.Worldsequence = worldsequence;
            edge.Version++;
            if (!await likes.TryUpsertAsync(edge, ct))
            {
                continue;
            }

            if (!append.WasDuplicate)
            {
                sink.Publish(append.Event.ToPublicDto());
            }

            var likeCount = await AdjustPostLikeAsync(postId, desired, ct);

            var result = new SocialReactionDto
            {
                PostId = postId,
                AccountId = accountId,
                Liked = desired,
                Changed = true,
                LikeCount = likeCount,
                UpdatedAt = now,
                Worldsequence = worldsequence.ToString(),
            };
            return new OperationOutcome<SocialReactionDto>(result, 200, null);
        }

        return ErrorResult.Create(ErrorCode.ConcurrencyConflict, "The like could not be applied due to contention; retry.", retryable: true);
    }

    private static long Bump(long value, bool increment) => increment ? value + 1 : Math.Max(0, value - 1);

    private async Task AdjustAccountAsync(string accountId, Action<SocialAccount> mutate, CancellationToken ct)
    {
        for (var attempt = 0; attempt < MaxConcurrencyRetries; attempt++)
        {
            var account = await accounts.GetAsync(accountId, ct);
            if (account is null)
            {
                return;
            }

            mutate(account);
            account.Version++;
            if (await accounts.TryUpdateAsync(account, ct))
            {
                return;
            }
        }
    }

    private async Task<long> AdjustPostLikeAsync(string postId, bool increment, CancellationToken ct)
    {
        for (var attempt = 0; attempt < MaxConcurrencyRetries; attempt++)
        {
            var post = await posts.GetAsync(postId, ct);
            if (post is null)
            {
                return 0;
            }

            post.LikeCount = Bump(post.LikeCount, increment);
            post.Version++;
            if (await posts.TryUpdateAsync(post, ct))
            {
                return post.LikeCount;
            }
        }

        return 0;
    }
}
