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

    /// <summary>Minimum post age before the repair sweep touches an incomplete post (past the idempotency
    /// pending lease), so repair never races an in-flight create effect.</summary>
    private const int RepairMinAgeSeconds = 60;

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

        // Persist the canonical post (idempotent by post id). Its creation worldsequence is NOT assigned
        // here — it is the envelope worldsequence of the post.created event appended below (one global
        // order). The rest of the create is a resumable, idempotent state machine (also run by repair).
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

        var dto = await AdvancePostAsync(stored, author, ct);
        var location = $"{_options.WorldBaseUrl}/social/posts/{postId}";
        return new OperationOutcome<SocialPostDto>(dto, 201, location);
    }

    /// <summary>
    /// Runs the idempotent post-create state machine from the post's current step and returns its current
    /// projection: <c>Persisted → EventAppended (assigns worldsequence) → Indexed → CountsUpdated → Done</c>.
    /// The <c>post.created</c>/<c>reply.created</c> event is appended with a deterministic dedupe key so a
    /// retry or a crash-repair reuses the SAME event and the SAME envelope worldsequence — never a gap, a
    /// duplicate, nor a Done post without its event. Used by both the create effect and the repair sweep.
    /// </summary>
    private async Task<SocialPostDto> AdvancePostAsync(SocialPost stored, SocialAccount author, CancellationToken ct)
    {
        var summary = author.ToSummary();
        var isReply = stored.ParentPostId is not null;
        var now = clock.GetUtcNow();

        // Step 1 — order the post: append the created/reply event, whose reserved envelope worldsequence
        // BECOMES the post's creation worldsequence and is embedded in the event's public data.
        if (stored.Step == SocialPostStep.Persisted)
        {
            var dedupe = SocialIds.EventDedupe("post-created", stored.PostId);
            var append = await worldEvents.AppendAsync(
                new WorldEvent
                {
                    EventId = SocialIds.EventId(dedupe),
                    Type = isReply ? SocialEventTypes.ReplyCreated : SocialEventTypes.PostCreated,
                    Source = SocialEventTypes.Source,
                    Subject = stored.PostId,
                    Time = stored.CreatedAt,
                    DedupeKey = dedupe,
                    CreatedAt = now,
                },
                ws =>
                {
                    var postDto = stored.ToDto(summary) with { Worldsequence = ws.ToString() };
                    return isReply ? eventFactory.ReplyCreated(postDto) : eventFactory.PostCreated(postDto);
                },
                ct);

            stored.Worldsequence = append.Event.Worldsequence;
            stored.Step = SocialPostStep.EventAppended;
            stored.Version++;
            if (await posts.TryUpdateAsync(stored, ct))
            {
                // The durable ledger is authoritative; a live push is best-effort and the /stream endpoint
                // de-duplicates by worldsequence, so publishing on a resume/replay converges rather than
                // double-delivering.
                sink.Publish(append.Event.ToPublicDto());
            }
            else
            {
                return (await posts.GetAsync(stored.PostId, ct))?.ToDto(summary) ?? stored.ToDto(summary);
            }
        }

        // Step 2 — feed index rows (global + author scope), idempotent by (scope, postId).
        if (stored.Step == SocialPostStep.EventAppended)
        {
            await feed.AddEntryAsync(NewEntry(SocialFeedEntry.GlobalScope, stored), ct);
            await feed.AddEntryAsync(NewEntry(stored.AuthorAccountId, stored), ct);
            stored.Step = SocialPostStep.Indexed;
            stored.Version++;
            if (!await posts.TryUpdateAsync(stored, ct))
            {
                return (await posts.GetAsync(stored.PostId, ct))?.ToDto(summary) ?? stored.ToDto(summary);
            }
        }

        // Step 3 — count projections set to their ABSOLUTE canonical values (idempotent). Because these are
        // absolute (not increments), a repair re-run of this step never over- or under-counts; the
        // maintenance reconciler converges any residual drift.
        if (stored.Step == SocialPostStep.Indexed)
        {
            var postCount = await posts.CountByAuthorAsync(stored.AuthorAccountId, ct);
            await SetAccountCountAsync(stored.AuthorAccountId, a => a.PostCount = postCount, ct);
            if (isReply && stored.ParentPostId is not null)
            {
                var replyCount = await posts.CountRepliesAsync(stored.ParentPostId, ct);
                await SetPostCountAsync(stored.ParentPostId, p => p.ReplyCount = replyCount, ct);
            }

            stored.Step = SocialPostStep.CountsUpdated;
            stored.Version++;
            if (!await posts.TryUpdateAsync(stored, ct))
            {
                return (await posts.GetAsync(stored.PostId, ct))?.ToDto(summary) ?? stored.ToDto(summary);
            }
        }

        // Step 4 — finalize.
        if (stored.Step == SocialPostStep.CountsUpdated)
        {
            stored.Step = SocialPostStep.Done;
            stored.Version++;
            await posts.TryUpdateAsync(stored, ct);
        }

        return stored.ToDto(summary);
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

        // Only repair posts old enough that no create effect could still be in flight (the idempotency
        // pending lease has elapsed), so repair never races an active create.
        var cutoff = clock.GetUtcNow().AddSeconds(-RepairMinAgeSeconds);
        var repaired = 0;
        foreach (var post in incomplete)
        {
            if (post.CreatedAt > cutoff)
            {
                continue;
            }

            var author = await accounts.GetAsync(post.AuthorAccountId, ct);
            if (author is null)
            {
                continue;
            }

            // Run the same idempotent state machine as create: append the post.created event (reusing the
            // deterministic dedupe ⇒ same envelope worldsequence, exactly one event), then feed + counts +
            // done. A post is never marked Done without its event.
            await AdvancePostAsync(post, author, ct);
            repaired++;
        }

        if (repaired > 0)
        {
            logger.LogDebug("Repaired {Count} incomplete social posts.", repaired);
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

    // Writes an ABSOLUTE account count projection (idempotent) with optimistic-concurrency retry.
    private async Task SetAccountCountAsync(string accountId, Action<SocialAccount> mutate, CancellationToken ct)
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

    // Writes an ABSOLUTE post count projection (idempotent) with optimistic-concurrency retry.
    private async Task SetPostCountAsync(string postId, Action<SocialPost> mutate, CancellationToken ct)
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
