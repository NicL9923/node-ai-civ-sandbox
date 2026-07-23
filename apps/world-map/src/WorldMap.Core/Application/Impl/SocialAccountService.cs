using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Common;
using WorldMap.Core.Configuration;
using WorldMap.Core.Contracts;
using WorldMap.Core.Domain;

namespace WorldMap.Core.Application.Impl;

/// <summary>
/// World Wire account sync (atomic, idempotent, one-civ upsert of 1-100 accounts) and public
/// account/follower/following reads. Account identity is World-owned and deterministic; a sync never
/// trusts a caller for identity beyond the natural key it validates. Sync is the explicit exception to
/// per-account rate limiting: it is HMAC + idempotency authenticated and owns the whole batch.
/// </summary>
public sealed class SocialAccountService(
    ISocialAccountRepository accounts,
    ISocialFollowRepository follows,
    IWorldEventRepository worldEvents,
    IdempotencyExecutor idempotency,
    SocialEventFactory eventFactory,
    IWorldEventSink sink,
    TimeProvider clock,
    IOptions<WorldMapOptions> options,
    ILogger<SocialAccountService> logger) : ISocialAccountService
{
    private readonly SocialOptions _social = options.Value.Social;

    public async Task<Result<SocialMutationEnvelope<SocialAccountSyncResponseDto>>> SyncAsync(
        string authenticatedCivId, SocialAccountSyncRequestDto request, string idempotencyKey, CancellationToken ct)
    {
        var validation = Validate(authenticatedCivId, request);
        if (validation is not null)
        {
            return validation;
        }

        var scope = $"social:sync:{authenticatedCivId}:{idempotencyKey}";
        var fingerprint = RequestFingerprint.Of(request);
        var ttl = TimeSpan.FromSeconds(_social.IdempotencyTtlSeconds);

        var outcome = await idempotency.ExecuteAsync<SocialAccountSyncResponseDto>(
            scope,
            fingerprint,
            ttl,
            innerCt => ApplySyncAsync(authenticatedCivId, request, scope, innerCt),
            body => body,
            ct);

        return outcome.IsSuccess
            ? new SocialMutationEnvelope<SocialAccountSyncResponseDto>(outcome.Value.Body, outcome.Value.StatusCode, outcome.Value.Location, null)
            : outcome.Error;
    }

    private async Task<Result<OperationOutcome<SocialAccountSyncResponseDto>>> ApplySyncAsync(
        string civId, SocialAccountSyncRequestDto request, string scope, CancellationToken ct)
    {
        var now = clock.GetUtcNow();

        // Build the plan (resolve each deterministic account id and whether it is a create or a replace).
        var plan = new List<(string AccountId, SocialAccountUpsertDto Upsert, SocialAccount? Existing)>(request.Accounts.Count);
        var createdCount = 0;
        var updatedCount = 0;
        foreach (var upsert in request.Accounts)
        {
            var accountId = SocialIds.AccountId(civId, upsert.Actor.Kind, upsert.Actor.LocalAgentId);
            var existing = await accounts.GetAsync(accountId, ct);
            if (existing is null)
            {
                createdCount++;
            }
            else
            {
                updatedCount++;
            }

            plan.Add((accountId, upsert, existing));
        }

        // One bounded citizen-safe summary event carries the whole batch (never individual records).
        var accountIds = plan.Select(p => p.AccountId).ToList();
        var eventData = new SocialAccountSyncedEventDataDto
        {
            CivId = civId,
            AccountIds = accountIds,
            CreatedCount = createdCount,
            UpdatedCount = updatedCount,
        };
        var dedupe = SocialIds.EventDedupe("account-synced", scope);
        var append = await worldEvents.AppendAsync(new WorldEvent
        {
            EventId = SocialIds.EventId(dedupe),
            Type = SocialEventTypes.AccountSynced,
            Source = SocialEventTypes.Source,
            Subject = civId,
            Time = now,
            PublicData = eventFactory.AccountSynced(eventData),
            DedupeKey = dedupe,
            CreatedAt = now,
        }, ct);
        var worldsequence = append.Event.Worldsequence;
        if (!append.WasDuplicate)
        {
            sink.Publish(append.Event.ToPublicDto());
        }

        // Apply create/replace under the single writer. Omitted accounts (not listed) are untouched.
        var responses = new List<SocialAccountDto>(plan.Count);
        foreach (var (accountId, upsert, existing) in plan)
        {
            SocialAccount account;
            if (existing is null)
            {
                account = new SocialAccount
                {
                    AccountId = accountId,
                    CivId = civId,
                    Kind = upsert.Actor.Kind,
                    LocalAgentId = upsert.Actor.LocalAgentId,
                    DisplayName = upsert.Actor.DisplayName,
                    Bio = upsert.Bio ?? string.Empty,
                    Status = SocialAccountStatus.Active,
                    OfficialAuthority = MapAuthority(upsert.OfficialAuthority),
                    Worldsequence = worldsequence,
                    CreatedAt = now,
                    UpdatedAt = now,
                    Version = 1,
                };
            }
            else
            {
                account = existing;
                account.DisplayName = upsert.Actor.DisplayName;
                account.Bio = upsert.Bio ?? string.Empty;
                account.OfficialAuthority = MapAuthority(upsert.OfficialAuthority);
                account.UpdatedAt = now;
                account.Version++;
            }

            await accounts.UpsertAsync(account, ct);
            responses.Add(account.ToDto(Policy()));
        }

        logger.LogDebug("Synced {Count} accounts for {CivId} ({Created} created, {Updated} updated).",
            plan.Count, civId, createdCount, updatedCount);

        var response = new SocialAccountSyncResponseDto { Accounts = responses };
        return new OperationOutcome<SocialAccountSyncResponseDto>(response, 200, null);
    }

    public async Task<Result<SocialAccountDto>> GetAsync(string accountId, CancellationToken ct)
    {
        var account = await accounts.GetAsync(accountId, ct);
        return account is null
            ? ErrorResult.Create(ErrorCode.SocialAccountNotFound, $"Social account '{accountId}' is unknown.")
            : account.ToDto(Policy());
    }

    public async Task<Result<SocialAccountPageDto>> ListFollowersAsync(string accountId, string? cursor, int? limit, CancellationToken ct)
    {
        var account = await accounts.GetAsync(accountId, ct);
        if (account is null)
        {
            return ErrorResult.Create(ErrorCode.SocialAccountNotFound, $"Social account '{accountId}' is unknown.");
        }

        var binding = new SocialCursorBinding(SocialFeedEndpoints.Followers, accountId, string.Empty, SocialFeedEndpoints.DescDirection);
        if (!SocialCursors.TryResolve(cursor, binding, out var state))
        {
            return CursorMismatch();
        }

        var take = _social.ClampPageLimit(limit);
        var hw = state?.HighWatermark ?? await follows.MaxFollowersWorldsequenceAsync(accountId, ct);
        var afterWs = state?.PositionWorldsequence ?? SocialCursors.DescStartWorldsequence;
        var afterTie = state?.PositionTieId ?? string.Empty;

        var edges = await follows.ListFollowersDescendingAsync(accountId, hw, afterWs, afterTie, take, ct);
        var summaries = await ResolveSummariesAsync(edges.Select(e => e.FollowerAccountId), ct);

        string? next = edges.Count == take && edges.Count > 0
            ? SocialCursors.Encode(binding, hw, edges[^1].Worldsequence, edges[^1].FollowerAccountId)
            : null;

        return new SocialAccountPageDto { Items = summaries, NextCursor = next };
    }

    public async Task<Result<SocialAccountPageDto>> ListFollowingAsync(string accountId, string? cursor, int? limit, CancellationToken ct)
    {
        var account = await accounts.GetAsync(accountId, ct);
        if (account is null)
        {
            return ErrorResult.Create(ErrorCode.SocialAccountNotFound, $"Social account '{accountId}' is unknown.");
        }

        var binding = new SocialCursorBinding(SocialFeedEndpoints.Following, accountId, string.Empty, SocialFeedEndpoints.DescDirection);
        if (!SocialCursors.TryResolve(cursor, binding, out var state))
        {
            return CursorMismatch();
        }

        var take = _social.ClampPageLimit(limit);
        var hw = state?.HighWatermark ?? await follows.MaxFollowedWorldsequenceAsync(accountId, ct);
        var afterWs = state?.PositionWorldsequence ?? SocialCursors.DescStartWorldsequence;
        var afterTie = state?.PositionTieId ?? string.Empty;

        var edges = await follows.ListFollowedDescendingAsync(accountId, hw, afterWs, afterTie, take, ct);
        var summaries = await ResolveSummariesAsync(edges.Select(e => e.FollowedAccountId), ct);

        string? next = edges.Count == take && edges.Count > 0
            ? SocialCursors.Encode(binding, hw, edges[^1].Worldsequence, edges[^1].FollowedAccountId)
            : null;

        return new SocialAccountPageDto { Items = summaries, NextCursor = next };
    }

    private async Task<IReadOnlyList<SocialAccountSummaryDto>> ResolveSummariesAsync(IEnumerable<string> accountIds, CancellationToken ct)
    {
        var summaries = new List<SocialAccountSummaryDto>();
        foreach (var id in accountIds)
        {
            var account = await accounts.GetAsync(id, ct);
            if (account is not null)
            {
                summaries.Add(account.ToSummary());
            }
        }

        return summaries;
    }

    private ErrorInfo? Validate(string authenticatedCivId, SocialAccountSyncRequestDto request)
    {
        if (!string.Equals(request.CivId, authenticatedCivId, StringComparison.Ordinal))
        {
            return ErrorResult.Create(ErrorCode.ForbiddenAccount, "The request civId must match the authenticated civilization.");
        }

        if (request.Accounts.Count is < 1 || request.Accounts.Count > _social.MaxSyncBatch)
        {
            return ErrorResult.Create(ErrorCode.ValidationFailed,
                $"An account sync must contain 1..{_social.MaxSyncBatch} accounts.",
                errors: [new FieldError("/accounts", $"must contain 1..{_social.MaxSyncBatch} items.")]);
        }

        var seen = new HashSet<string>(StringComparer.Ordinal);
        var officialCount = 0;
        for (var i = 0; i < request.Accounts.Count; i++)
        {
            var upsert = request.Accounts[i];
            var actor = upsert.Actor;

            if (!string.Equals(actor.CivId, request.CivId, StringComparison.Ordinal))
            {
                return ErrorResult.Create(ErrorCode.ValidationFailed, "Every account actor.civId must equal the request civId.",
                    errors: [new FieldError($"/accounts/{i}/actor/civId", "must match the request civId.")]);
            }

            if (SocialText.ValidateDisplayName(actor.DisplayName, _social.MaxDisplayNameCodePoints) is { } nameError)
            {
                return nameError;
            }

            if (SocialText.ValidateBio(upsert.Bio, _social.MaxBioCodePoints) is { } bioError)
            {
                return bioError;
            }

            if (string.Equals(actor.Kind, SocialAccountKind.System, StringComparison.Ordinal))
            {
                return ErrorResult.Create(ErrorCode.SystemAccountReserved, "The system account kind is reserved for the World.");
            }

            string naturalKey;
            if (string.Equals(actor.Kind, SocialAccountKind.Official, StringComparison.Ordinal))
            {
                if (!string.IsNullOrEmpty(actor.LocalAgentId))
                {
                    return ErrorResult.Create(ErrorCode.ValidationFailed, "An official account must not carry a localAgentId.",
                        errors: [new FieldError($"/accounts/{i}/actor/localAgentId", "not allowed on official identity.")]);
                }

                if (upsert.OfficialAuthority is null)
                {
                    return ErrorResult.Create(ErrorCode.OfficialAccountConflict, "An official account requires officialAuthority.");
                }

                if (ValidateAuthority(upsert.OfficialAuthority, i) is { } authError)
                {
                    return authError;
                }

                officialCount++;
                if (officialCount > 1)
                {
                    return ErrorResult.Create(ErrorCode.OfficialAccountConflict, "A sync batch may contain at most one official account.");
                }

                naturalKey = "official";
            }
            else if (string.Equals(actor.Kind, SocialAccountKind.Agent, StringComparison.Ordinal))
            {
                if (string.IsNullOrEmpty(actor.LocalAgentId))
                {
                    return ErrorResult.Create(ErrorCode.ValidationFailed, "An agent account requires a localAgentId.",
                        errors: [new FieldError($"/accounts/{i}/actor/localAgentId", "required for agent accounts.")]);
                }

                naturalKey = $"agent\u0000{actor.LocalAgentId}";
            }
            else
            {
                // Open future kind: keyed by (kind, localAgentId) so it stays unique.
                naturalKey = $"{actor.Kind}\u0000{actor.LocalAgentId ?? string.Empty}";
            }

            if (!seen.Add(naturalKey))
            {
                return ErrorResult.Create(ErrorCode.ValidationFailed, "Duplicate account natural key in the batch.",
                    errors: [new FieldError($"/accounts/{i}", "duplicate natural key.")]);
            }
        }

        return null;
    }

    private ErrorInfo? ValidateAuthority(SocialOfficialAuthorityDto authority, int index)
    {
        if (SocialText.ValidateDisplayName(authority.PresidentDisplayName, _social.MaxDisplayNameCodePoints) is { } nameError)
        {
            return nameError;
        }

        if (string.IsNullOrEmpty(authority.PresidentLocalAgentId))
        {
            return ErrorResult.Create(ErrorCode.OfficialAccountConflict, "officialAuthority.presidentLocalAgentId is required.",
                errors: [new FieldError($"/accounts/{index}/officialAuthority/presidentLocalAgentId", "required.")]);
        }

        if (string.IsNullOrEmpty(authority.AuthorityDecision?.Ref))
        {
            return ErrorResult.Create(ErrorCode.OfficialAccountConflict, "officialAuthority.authorityDecision.ref is required.",
                errors: [new FieldError($"/accounts/{index}/officialAuthority/authorityDecision/ref", "required.")]);
        }

        return null;
    }

    private static SocialOfficialAuthority? MapAuthority(SocialOfficialAuthorityDto? dto) =>
        dto is null
            ? null
            : new SocialOfficialAuthority
            {
                PresidentLocalAgentId = dto.PresidentLocalAgentId,
                PresidentDisplayName = dto.PresidentDisplayName,
                TermNumber = dto.TermNumber,
                DecisionMode = dto.AuthorityDecision.Mode ?? string.Empty,
                DecisionRef = dto.AuthorityDecision.Ref ?? string.Empty,
                DecisionAuthorizedAt = dto.AuthorityDecision.AuthorizedAt,
            };

    private SocialRateLimitPolicyDto Policy() => new()
    {
        PostCooldownSeconds = _social.RateLimit.PostCooldownSeconds,
        PostsPerWindow = _social.RateLimit.PostsPerWindow,
        ReactionsPerWindow = _social.RateLimit.ReactionsPerWindow,
        FollowsPerWindow = _social.RateLimit.FollowsPerWindow,
        WindowSeconds = _social.RateLimit.WindowSeconds,
    };

    private static ErrorInfo CursorMismatch() =>
        ErrorResult.Create(ErrorCode.CursorFilterMismatch, "The cursor was used with a different endpoint, account, or filter.");
}
