using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Common;
using WorldMap.Core.Configuration;
using WorldMap.Core.Contracts;
using WorldMap.Core.Domain;

namespace WorldMap.Core.Application.Impl;

/// <summary>
/// World Wire post create/read/thread/tombstone. Text is immutable; the World derives root/depth and
/// stores the exact submitted text. Canonical post state is single-writer; feed index and projected
/// counts are eventually consistent and repaired after a crash. Mutations flow through the shared
/// idempotency + per-account rate-limit pipeline.
/// </summary>
public sealed class SocialPostService(
    ISocialAccountRepository accounts,
    ISocialPostRepository posts,
    ISocialFeedRepository feed,
    IWorldEventRepository worldEvents,
    SocialMutationPipeline pipeline,
    SocialEventFactory eventFactory,
    IWorldEventSink sink,
    TimeProvider clock,
    IOptions<WorldMapOptions> options,
    ILogger<SocialPostService> logger) : ISocialPostService
{
    private const int MaxConcurrencyRetries = 8;
    private readonly WorldMapOptions _options = options.Value;

    public async Task<Result<SocialMutationEnvelope<SocialPostDto>>> CreateAsync(
        string authenticatedCivId, SocialPostCreateRequestDto request, string idempotencyKey, CancellationToken ct)
    {
        if (SocialText.ValidatePostText(request.Text, _options.Social.MaxTextCodePoints) is { } textError)
        {
            return textError;
        }

        var scope = $"social:post:{authenticatedCivId}:{idempotencyKey}";
        var fingerprint = RequestFingerprint.Of(request);
        var postId = SocialIds.PostId(scope);

        // Resolve + authorize the author before claiming/rate-limiting so a 4xx neither claims a key nor
        // consumes rate budget.
        var author = await accounts.GetAsync(request.AuthorAccountId, ct);
        var authz = SocialAuthorization.Authorize(author, request.AuthorAccountId, authenticatedCivId, request.Authorization);
        if (!authz.IsSuccess)
        {
            return authz.Error;
        }

        // Resolve root/depth from the parent (server-derived; never client-writable).
        string conversationRootPostId = postId;
        string? parentPostId = null;
        var replyDepth = 0;
        if (!string.IsNullOrEmpty(request.ParentPostId))
        {
            var parent = await posts.GetAsync(request.ParentPostId, ct);
            if (parent is null)
            {
                return ErrorResult.Create(ErrorCode.PostNotFound, $"Parent post '{request.ParentPostId}' is unknown.");
            }

            if (parent.IsTombstoned)
            {
                return ErrorResult.Create(ErrorCode.PostTombstoned, "Cannot reply to a tombstoned post.");
            }

            replyDepth = parent.ReplyDepth + 1;
            if (replyDepth > _options.Social.MaxReplyDepth)
            {
                return ErrorResult.Create(ErrorCode.ReplyDepthExceeded, $"A reply may not exceed depth {_options.Social.MaxReplyDepth}.");
            }

            parentPostId = parent.PostId;
            conversationRootPostId = parent.ConversationRootPostId;
        }

        var authorAccount = authz.Value;
        var isReply = parentPostId is not null;

        return await pipeline.RunAsync<SocialPostDto>(
            scope,
            fingerprint,
            request.AuthorAccountId,
            SocialQuota.Post,
            innerCt => CreateEffectAsync(request, postId, conversationRootPostId, parentPostId, replyDepth, isReply, authorAccount, scope, innerCt),
            ct);
    }

    private async Task<Result<OperationOutcome<SocialPostDto>>> CreateEffectAsync(
        SocialPostCreateRequestDto request, string postId, string conversationRootPostId, string? parentPostId,
        int replyDepth, bool isReply, SocialAccount author, string scope, CancellationToken ct)
    {
        var now = clock.GetUtcNow();

        // 1. Persist the canonical post (idempotent). The repository assigns the creation worldsequence
        //    (allocate-through-insert) so it is known before we build the ordered event/feed rows.
        var stored = await posts.AddAsync(new SocialPost
        {
            PostId = postId,
            AuthorAccountId = author.AccountId,
            ConversationRootPostId = conversationRootPostId,
            ParentPostId = parentPostId,
            ReplyDepth = replyDepth,
            Status = SocialPostStatus.Published,
            Text = request.Text,
            CreatedAt = now,
            Step = SocialPostStep.Persisted,
            Version = 1,
        }, ct);

        var authorSummary = author.ToSummary();
        var postDto = stored.ToDto(authorSummary);

        // 2. Append the ordered public created/reply event (idempotent by dedupe) and feed the SSE stream.
        var dedupe = SocialIds.EventDedupe("post-created", postId);
        var append = await worldEvents.AppendAsync(new WorldEvent
        {
            EventId = SocialIds.EventId(dedupe),
            Type = isReply ? SocialEventTypes.ReplyCreated : SocialEventTypes.PostCreated,
            Source = SocialEventTypes.Source,
            Subject = postId,
            Time = stored.CreatedAt,
            PublicData = isReply ? eventFactory.ReplyCreated(postDto) : eventFactory.PostCreated(postDto),
            DedupeKey = dedupe,
            CreatedAt = now,
        }, ct);
        if (!append.WasDuplicate)
        {
            sink.Publish(append.Event.ToPublicDto());
        }

        // 3. Feed index rows (global + author scope) — idempotent by (scope, postId).
        await feed.AddEntryAsync(NewEntry(SocialFeedEntry.GlobalScope, stored), ct);
        await feed.AddEntryAsync(NewEntry(author.AccountId, stored), ct);

        // 4. Eventually-consistent count projections, guarded by the post's process step so a replay of a
        //    completed create never double-counts. (A crash strictly between the count writes and the step
        //    advance is a bounded projection-drift window repaired by reconciliation.)
        if (stored.Step == SocialPostStep.Persisted)
        {
            await IncrementAsync(author.AccountId, a => a.PostCount++, ct);
            if (isReply && parentPostId is not null)
            {
                await IncrementPostAsync(parentPostId, p => p.ReplyCount++, ct);
            }

            stored.Step = SocialPostStep.Done;
            stored.Version++;
            await posts.TryUpdateAsync(stored, ct);
        }

        var location = $"{_options.WorldBaseUrl}/social/posts/{postId}";
        return new OperationOutcome<SocialPostDto>(postDto, 201, location);
    }

    public async Task<Result<SocialPostDto>> GetAsync(string postId, CancellationToken ct)
    {
        var post = await posts.GetAsync(postId, ct);
        if (post is null)
        {
            return ErrorResult.Create(ErrorCode.PostNotFound, $"Post '{postId}' is unknown.");
        }

        var author = await accounts.GetAsync(post.AuthorAccountId, ct);
        return author is null
            ? ErrorResult.Create(ErrorCode.Internal, "The post's author account could not be resolved.", retryable: true)
            : post.ToDto(author.ToSummary());
    }

    public async Task<Result<SocialThreadPageDto>> GetThreadAsync(string postId, string? cursor, int? limit, CancellationToken ct)
    {
        var member = await posts.GetAsync(postId, ct);
        if (member is null)
        {
            return ErrorResult.Create(ErrorCode.PostNotFound, $"Post '{postId}' is unknown.");
        }

        var root = member.ConversationRootPostId;
        var binding = new SocialCursorBinding(SocialFeedEndpoints.Thread, root, string.Empty, SocialFeedEndpoints.AscDirection);
        if (!SocialCursors.TryResolve(cursor, binding, out var state))
        {
            return CursorMismatch();
        }

        var take = _options.Social.ClampPageLimit(limit);
        var hw = state?.HighWatermark ?? await posts.MaxThreadWorldsequenceAsync(root, ct);
        var afterWs = state?.PositionWorldsequence ?? SocialCursors.AscStartWorldsequence;
        var afterTie = state?.PositionTieId ?? string.Empty;

        var page = await posts.ListThreadAsync(root, hw, afterWs, afterTie, take, ct);
        var items = await ToDtosAsync(page, ct);

        string? next = page.Count == take && page.Count > 0
            ? SocialCursors.Encode(binding, hw, page[^1].Worldsequence, page[^1].PostId)
            : null;

        return new SocialThreadPageDto { ConversationRootPostId = root, Items = items, NextCursor = next };
    }

    public async Task<Result<SocialMutationEnvelope<SocialPostDto>>> TombstoneAsync(
        string authenticatedCivId, string postId, SocialPostTombstoneRequestDto request, string idempotencyKey, CancellationToken ct)
    {
        var post = await posts.GetAsync(postId, ct);
        if (post is null)
        {
            return ErrorResult.Create(ErrorCode.PostNotFound, $"Post '{postId}' is unknown.");
        }

        var author = await accounts.GetAsync(post.AuthorAccountId, ct);
        var authz = SocialAuthorization.Authorize(author, post.AuthorAccountId, authenticatedCivId, request.Authorization);
        if (!authz.IsSuccess)
        {
            return authz.Error;
        }

        var scope = $"social:tombstone:{authenticatedCivId}:{idempotencyKey}";
        var fingerprint = RequestFingerprint.Of(request);

        return await pipeline.RunAsync<SocialPostDto>(
            scope,
            fingerprint,
            post.AuthorAccountId,
            SocialQuota.Post,
            innerCt => TombstoneEffectAsync(postId, authz.Value, scope, innerCt),
            ct);
    }

    private async Task<Result<OperationOutcome<SocialPostDto>>> TombstoneEffectAsync(
        string postId, SocialAccount author, string scope, CancellationToken ct)
    {
        for (var attempt = 0; attempt < MaxConcurrencyRetries; attempt++)
        {
            var post = await posts.GetAsync(postId, ct);
            if (post is null)
            {
                return ErrorResult.Create(ErrorCode.PostNotFound, $"Post '{postId}' is unknown.");
            }

            var summary = author.ToSummary();

            // Terminal + idempotent: an already-tombstoned post returns its current projection unchanged.
            if (post.IsTombstoned)
            {
                return new OperationOutcome<SocialPostDto>(post.ToDto(summary), 200, null);
            }

            var now = clock.GetUtcNow();
            post.Status = SocialPostStatus.Tombstoned;
            post.Text = null;
            post.TombstonedAt = now;
            post.Version++;
            if (!await posts.TryUpdateAsync(post, ct))
            {
                continue; // Concurrent writer — reload and retry the CAS.
            }

            var dedupe = SocialIds.EventDedupe("post-tombstoned", postId);
            var append = await worldEvents.AppendAsync(new WorldEvent
            {
                EventId = SocialIds.EventId(dedupe),
                Type = SocialEventTypes.PostTombstoned,
                Source = SocialEventTypes.Source,
                Subject = postId,
                Time = now,
                PublicData = eventFactory.Tombstoned(new SocialPostTombstonedEventDataDto
                {
                    PostId = post.PostId,
                    AuthorAccountId = post.AuthorAccountId,
                    ConversationRootPostId = post.ConversationRootPostId,
                    TombstonedAt = now,
                }),
                DedupeKey = dedupe,
                CreatedAt = now,
            }, ct);
            if (!append.WasDuplicate)
            {
                sink.Publish(append.Event.ToPublicDto());
            }

            return new OperationOutcome<SocialPostDto>(post.ToDto(summary), 200, null);
        }

        return ErrorResult.Create(ErrorCode.ConcurrencyConflict, "The post could not be tombstoned due to contention; retry.", retryable: true);
    }

    public async Task RepairIncompleteAsync(CancellationToken ct)
    {
        var incomplete = await posts.ListIncompleteAsync(ct);
        foreach (var post in incomplete)
        {
            // Re-run the idempotent feed indexing and advance the step. Count projections are NOT re-applied
            // here (they may have already been applied before the crash), keeping repair convergent.
            await feed.AddEntryAsync(NewEntry(SocialFeedEntry.GlobalScope, post), ct);
            await feed.AddEntryAsync(NewEntry(post.AuthorAccountId, post), ct);

            if (post.Step != SocialPostStep.Done)
            {
                post.Step = SocialPostStep.Done;
                post.Version++;
                await posts.TryUpdateAsync(post, ct);
            }
        }

        if (incomplete.Count > 0)
        {
            logger.LogDebug("Repaired {Count} incomplete social posts.", incomplete.Count);
        }
    }

    private static SocialFeedEntry NewEntry(string scope, SocialPost post) => new()
    {
        FeedScope = scope,
        PostId = post.PostId,
        ConversationRootPostId = post.ConversationRootPostId,
        AuthorAccountId = post.AuthorAccountId,
        Worldsequence = post.Worldsequence,
        CreatedAt = post.CreatedAt,
    };

    private async Task<IReadOnlyList<SocialPostDto>> ToDtosAsync(IReadOnlyList<SocialPost> page, CancellationToken ct)
    {
        var dtos = new List<SocialPostDto>(page.Count);
        var summaries = new Dictionary<string, SocialAccountSummaryDto>(StringComparer.Ordinal);
        foreach (var post in page)
        {
            if (!summaries.TryGetValue(post.AuthorAccountId, out var summary))
            {
                var account = await accounts.GetAsync(post.AuthorAccountId, ct);
                summary = account?.ToSummary() ?? new SocialAccountSummaryDto
                {
                    AccountId = post.AuthorAccountId,
                    Actor = new SocialActorRefDto { CivId = string.Empty, DisplayName = post.AuthorAccountId, Kind = SocialAccountKind.Agent },
                    Status = SocialAccountStatus.Active,
                };
                summaries[post.AuthorAccountId] = summary;
            }

            dtos.Add(post.ToDto(summary));
        }

        return dtos;
    }

    private async Task IncrementAsync(string accountId, Action<SocialAccount> mutate, CancellationToken ct)
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

    private async Task IncrementPostAsync(string postId, Action<SocialPost> mutate, CancellationToken ct)
    {
        for (var attempt = 0; attempt < MaxConcurrencyRetries; attempt++)
        {
            var post = await posts.GetAsync(postId, ct);
            if (post is null)
            {
                return;
            }

            mutate(post);
            post.Version++;
            if (await posts.TryUpdateAsync(post, ct))
            {
                return;
            }
        }
    }

    private static ErrorInfo CursorMismatch() =>
        ErrorResult.Create(ErrorCode.CursorFilterMismatch, "The cursor was used with a different endpoint, account, or filter.");
}
