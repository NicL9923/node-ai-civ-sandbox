using WorldMap.Core.Abstractions;
using WorldMap.Core.Common;
using WorldMap.Core.Contracts;
using WorldMap.Core.Domain;

namespace WorldMap.Core.Application.Impl;

/// <summary>
/// World Wire desired-state follow and like mutations. Canonical edge sets are World-owned and
/// single-writer. A transition is committed by a CAS that marks the edge <c>Pending</c>; the public event
/// is appended ONLY after that CAS, with a dedupe key derived from the edge identity + transition version,
/// so concurrent same-transition requests produce exactly one event (one <c>changed:true</c>, the rest
/// no-ops) and on→off→on yields one event per transition. A crash after the CAS but before the append
/// leaves the edge <c>Pending</c>; the next actor (a retry, a concurrent request, or the repair sweep)
/// completes exactly that one event. Self-follow is forbidden; self-like is allowed.
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

    /// <summary>Minimum edge age before the repair sweep completes a pending transition (past the
    /// idempotency pending lease), so repair never races an in-flight mutation.</summary>
    private const int RepairMinAgeSeconds = 60;

    // --- Follow ---

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

        if (await accounts.GetAsync(targetAccountId, ct) is null)
        {
            return ErrorResult.Create(ErrorCode.SocialAccountNotFound, $"Social account '{targetAccountId}' is unknown.");
        }

        var scope = $"social:follow:{authenticatedCivId}:{idempotencyKey}";
        var fingerprint = RequestFingerprint.Of(request);

        return await pipeline.RunAsync<SocialFollowDto>(
            scope, fingerprint, accountId, SocialQuota.Follow,
            innerCt => FollowEffectAsync(accountId, targetAccountId, request.Following, innerCt),
            ct);
    }

    private async Task<Result<OperationOutcome<SocialFollowDto>>> FollowEffectAsync(
        string followerAccountId, string followedAccountId, bool desired, CancellationToken ct)
    {
        for (var attempt = 0; attempt < MaxConcurrencyRetries; attempt++)
        {
            var now = clock.GetUtcNow();
            var edge = await follows.GetAsync(followerAccountId, followedAccountId, ct);

            // Complete any crash-left pending transition first (idempotent by version), so the edge's event
            // is emitted exactly once before this request evaluates its own desired state.
            if (edge is { Pending: true })
            {
                var resumed = await CompleteFollowTransitionAsync(edge, ct);
                if (resumed is null)
                {
                    continue; // Lost the mark-evented CAS — reload and retry.
                }

                edge = resumed;
            }

            var current = edge?.Following ?? false;
            if (current == desired)
            {
                return new OperationOutcome<SocialFollowDto>(
                    FollowDto(followerAccountId, followedAccountId, current, changed: false, edge?.Worldsequence ?? 0, edge?.UpdatedAt ?? now), 200, null);
            }

            // Flip: commit the new state as Pending (the event is appended only after this CAS wins).
            edge ??= new SocialFollow { FollowerAccountId = followerAccountId, FollowedAccountId = followedAccountId };
            edge.Following = desired;
            edge.Pending = true;
            edge.UpdatedAt = now;
            edge.Version++;
            if (!await follows.TryUpsertAsync(edge, ct))
            {
                continue; // Lost the flip race — reload; the winner owns this transition.
            }

            // Eventually-consistent counts are applied inside the transition completion (below), so a
            // crash after this flip CAS is repaired for BOTH the event and the counts by the sweep.
            var completed = await CompleteFollowTransitionAsync(edge, ct);
            var ws = completed?.Worldsequence ?? (await follows.GetAsync(followerAccountId, followedAccountId, ct))?.Worldsequence ?? 0;
            return new OperationOutcome<SocialFollowDto>(
                FollowDto(followerAccountId, followedAccountId, desired, changed: true, ws, now), 200, null);
        }

        return ErrorResult.Create(ErrorCode.ConcurrencyConflict, "The follow could not be applied due to contention; retry.", retryable: true);
    }

    /// <summary>
    /// Appends the follow-changed event for the edge's committed (pending) transition — idempotent by
    /// (edge, version) — sets the edge's ordering worldsequence, clears <c>Pending</c>, and publishes.
    /// Returns the updated edge, or null if the mark-evented CAS was lost (the caller retries).
    /// </summary>
    private async Task<SocialFollow?> CompleteFollowTransitionAsync(SocialFollow edge, CancellationToken ct)
    {
        if (!edge.Pending)
        {
            return edge;
        }

        var now = clock.GetUtcNow();
        var docId = SocialIds.FollowDocId(edge.FollowerAccountId, edge.FollowedAccountId);
        var dedupe = SocialIds.EventDedupe("follow-changed", $"{docId}:v{edge.Version}");
        var append = await worldEvents.AppendAsync(new WorldEvent
        {
            EventId = SocialIds.EventId(dedupe),
            Type = edge.Following ? SocialEventTypes.AccountFollowed : SocialEventTypes.AccountUnfollowed,
            Source = SocialEventTypes.Source,
            Subject = edge.FollowedAccountId,
            Time = now,
            PublicData = eventFactory.FollowChanged(new SocialFollowChangedEventDataDto
            {
                FollowerAccountId = edge.FollowerAccountId,
                FollowedAccountId = edge.FollowedAccountId,
                Following = edge.Following,
                ChangedAt = now,
            }),
            DedupeKey = dedupe,
            CreatedAt = now,
        }, ct);

        edge.Worldsequence = append.Event.Worldsequence;
        edge.Pending = false;
        edge.Version++;
        if (!await follows.TryUpsertAsync(edge, ct))
        {
            return null; // Another actor completed this transition — the caller reloads.
        }

        // This caller won the mark-evented CAS ⇒ it owns the transition: apply the projected counts
        // exactly once. Because counts live in the completion path, a crash after the flip CAS is repaired
        // (event AND counts) by RepairPendingAsync — not just the event.
        await AdjustAccountAsync(edge.FollowerAccountId, a => a.FollowingCount = Bump(a.FollowingCount, edge.Following), ct);
        await AdjustAccountAsync(edge.FollowedAccountId, a => a.FollowerCount = Bump(a.FollowerCount, edge.Following), ct);

        // Durable ledger is authoritative; a live push is best-effort and /stream de-dupes by worldsequence.
        sink.Publish(append.Event.ToPublicDto());
        return edge;
    }

    // --- Like ---

    public async Task<Result<SocialMutationEnvelope<SocialReactionDto>>> SetLikeAsync(
        string authenticatedCivId, string postId, string accountId, SocialReactionSetRequestDto request, string idempotencyKey, CancellationToken ct)
    {
        if (await posts.GetAsync(postId, ct) is null)
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
            scope, fingerprint, accountId, SocialQuota.Reaction,
            innerCt => LikeEffectAsync(postId, accountId, request.Liked, innerCt),
            ct);
    }

    private async Task<Result<OperationOutcome<SocialReactionDto>>> LikeEffectAsync(
        string postId, string accountId, bool desired, CancellationToken ct)
    {
        for (var attempt = 0; attempt < MaxConcurrencyRetries; attempt++)
        {
            var now = clock.GetUtcNow();
            var edge = await likes.GetAsync(postId, accountId, ct);

            if (edge is { Pending: true })
            {
                var resumed = await CompleteLikeTransitionAsync(edge, ct);
                if (resumed is null)
                {
                    continue;
                }

                edge = resumed;
            }

            var current = edge?.Liked ?? false;
            if (current == desired)
            {
                var likeCount = (await posts.GetAsync(postId, ct))?.LikeCount ?? 0;
                return new OperationOutcome<SocialReactionDto>(
                    ReactionDto(postId, accountId, current, changed: false, likeCount, edge?.Worldsequence ?? 0, edge?.UpdatedAt ?? now), 200, null);
            }

            edge ??= new SocialLike { PostId = postId, AccountId = accountId };
            edge.Liked = desired;
            edge.Pending = true;
            edge.UpdatedAt = now;
            edge.Version++;
            if (!await likes.TryUpsertAsync(edge, ct))
            {
                continue;
            }

            var completed = await CompleteLikeTransitionAsync(edge, ct);
            var ws = completed?.Worldsequence ?? (await likes.GetAsync(postId, accountId, ct))?.Worldsequence ?? 0;
            var count = (await posts.GetAsync(postId, ct))?.LikeCount ?? 0;
            return new OperationOutcome<SocialReactionDto>(
                ReactionDto(postId, accountId, desired, changed: true, count, ws, now), 200, null);
        }

        return ErrorResult.Create(ErrorCode.ConcurrencyConflict, "The like could not be applied due to contention; retry.", retryable: true);
    }

    private async Task<SocialLike?> CompleteLikeTransitionAsync(SocialLike edge, CancellationToken ct)
    {
        if (!edge.Pending)
        {
            return edge;
        }

        var now = clock.GetUtcNow();
        var docId = SocialIds.LikeDocId(edge.PostId, edge.AccountId);
        var dedupe = SocialIds.EventDedupe("reaction-changed", $"{docId}:v{edge.Version}");
        var append = await worldEvents.AppendAsync(new WorldEvent
        {
            EventId = SocialIds.EventId(dedupe),
            Type = edge.Liked ? SocialEventTypes.PostLiked : SocialEventTypes.PostUnliked,
            Source = SocialEventTypes.Source,
            Subject = edge.PostId,
            Time = now,
            PublicData = eventFactory.ReactionChanged(new SocialPostReactionChangedEventDataDto
            {
                PostId = edge.PostId,
                AccountId = edge.AccountId,
                Liked = edge.Liked,
                ChangedAt = now,
            }),
            DedupeKey = dedupe,
            CreatedAt = now,
        }, ct);

        edge.Worldsequence = append.Event.Worldsequence;
        edge.Pending = false;
        edge.Version++;
        if (!await likes.TryUpsertAsync(edge, ct))
        {
            return null;
        }

        // Owner of the transition (mark-evented CAS winner) applies the projected like count exactly once;
        // repair reconciles it after a crash via the same path.
        await AdjustPostLikeAsync(edge.PostId, edge.Liked, ct);

        sink.Publish(append.Event.ToPublicDto());
        return edge;
    }

    // --- Repair (crash after CAS before event append) ---

    public async Task RepairPendingAsync(CancellationToken ct)
    {
        var cutoff = clock.GetUtcNow().AddSeconds(-RepairMinAgeSeconds);

        foreach (var edge in await follows.ListPendingAsync(ct))
        {
            if (edge.UpdatedAt <= cutoff)
            {
                await CompleteFollowTransitionAsync(edge, ct);
            }
        }

        foreach (var edge in await likes.ListPendingAsync(ct))
        {
            if (edge.UpdatedAt <= cutoff)
            {
                await CompleteLikeTransitionAsync(edge, ct);
            }
        }
    }

    // --- Helpers ---

    private static SocialFollowDto FollowDto(string follower, string followed, bool following, bool changed, long ws, DateTimeOffset updatedAt) => new()
    {
        FollowerAccountId = follower,
        FollowedAccountId = followed,
        Following = following,
        Changed = changed,
        UpdatedAt = updatedAt,
        Worldsequence = ws.ToString(),
    };

    private static SocialReactionDto ReactionDto(string postId, string accountId, bool liked, bool changed, long likeCount, long ws, DateTimeOffset updatedAt) => new()
    {
        PostId = postId,
        AccountId = accountId,
        Liked = liked,
        Changed = changed,
        LikeCount = likeCount,
        UpdatedAt = updatedAt,
        Worldsequence = ws.ToString(),
    };

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
