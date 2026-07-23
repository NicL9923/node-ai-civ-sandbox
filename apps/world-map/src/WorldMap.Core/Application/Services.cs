using WorldMap.Core.Common;
using WorldMap.Core.Contracts;

namespace WorldMap.Core.Application;

/// <summary>Registration outcome plus the Location header value for the created civ.</summary>
public sealed record RegistrationResult(RegistrationResponseDto Body, string Location);

/// <summary>Interaction submission outcome plus the Location/status URL for the 202 response.</summary>
public sealed record InteractionSubmitResult(AcceptedDto Body, string Location);

/// <summary>Civilization onboarding (bootstrap, onboarding-token authenticated).</summary>
public interface IOnboardingService
{
    Task<Result<RegistrationResult>> RegisterAsync(
        RegistrationRequestDto request,
        string idempotencyKey,
        CancellationToken ct);
}

/// <summary>Civilization liveness + public projection reads.</summary>
public interface ICivilizationService
{
    Task<Result<HeartbeatAckDto>> HeartbeatAsync(
        string civId,
        HeartbeatDto request,
        CancellationToken ct);

    Task<Result<CivilizationListPageDto>> ListAsync(string? after, int? limit, CancellationToken ct);

    Task<Result<PublicProjectionDto>> GetAsync(string civId, CancellationToken ct);
}

/// <summary>Civ event ingestion and the public world-event feed.</summary>
public interface IEventService
{
    Task<Result<EventBatchResultDto>> IngestBatchAsync(
        string civId,
        EventBatchDto request,
        string idempotencyKey,
        CancellationToken ct);

    Task<Result<EventPageDto>> ListWorldEventsAsync(string? after, int? limit, CancellationToken ct);

    /// <summary>Reads events strictly after an ordinal (backs SSE polling). Returns items + last ordinal.</summary>
    Task<Result<(IReadOnlyList<CloudEventDto> Items, long LastOrdinal)>> ReadAfterAsync(
        long afterOrdinal,
        int limit,
        CancellationToken ct);
}

/// <summary>World-originated command pull + ack for a civ.</summary>
public interface ICommandService
{
    Task<Result<CommandPageDto>> PullAsync(string civId, string? after, int? limit, CancellationToken ct);

    Task<Result<CommandAckResultDto>> AckAsync(
        string civId,
        string commandId,
        CommandAckDto request,
        string idempotencyKey,
        CancellationToken ct);
}

/// <summary>President-authorized inter-civ contact/message interactions.</summary>
public interface IInteractionService
{
    Task<Result<InteractionSubmitResult>> SubmitAsync(
        string authenticatedCivId,
        InteractionRequestDto request,
        string idempotencyKey,
        CancellationToken ct);

    /// <summary>Reads an interaction's status. Only its source or target civ is authorized.</summary>
    Task<Result<InteractionDto>> GetAsync(string requesterCivId, string interactionId, CancellationToken ct);
}

/// <summary>
/// Drives (and resumes) the durable interaction process manager. Idempotent and safe to call
/// inline after acceptance and again from the maintenance worker.
/// </summary>
public interface IInteractionProcessor
{
    Task ProcessAsync(string interactionId, CancellationToken ct);
}

/// <summary>Public relationship projections (list or single-pair lookup).</summary>
public interface IRelationshipService
{
    Task<Result<RelationshipPageDto>> ListAsync(
        string? after,
        int? limit,
        string? civA,
        string? civB,
        CancellationToken ct);
}

/// <summary>Background maintenance operations (liveness, expiry). Invoked by the worker.</summary>
public interface IMaintenanceService
{
    Task SweepAsync(CancellationToken ct);
}

/// <summary>World Wire account sync (HMAC + idempotency) and public account/follower/following reads.</summary>
public interface ISocialAccountService
{
    Task<Result<SocialMutationEnvelope<SocialAccountSyncResponseDto>>> SyncAsync(
        string authenticatedCivId, SocialAccountSyncRequestDto request, string idempotencyKey, CancellationToken ct);

    Task<Result<SocialAccountDto>> GetAsync(string accountId, CancellationToken ct);

    Task<Result<SocialAccountPageDto>> ListFollowersAsync(string accountId, string? cursor, int? limit, CancellationToken ct);

    Task<Result<SocialAccountPageDto>> ListFollowingAsync(string accountId, string? cursor, int? limit, CancellationToken ct);
}

/// <summary>World Wire post create/get/thread/tombstone.</summary>
public interface ISocialPostService
{
    Task<Result<SocialMutationEnvelope<SocialPostDto>>> CreateAsync(
        string authenticatedCivId, SocialPostCreateRequestDto request, string idempotencyKey, CancellationToken ct);

    Task<Result<SocialPostDto>> GetAsync(string postId, CancellationToken ct);

    Task<Result<SocialThreadPageDto>> GetThreadAsync(string postId, string? cursor, int? limit, CancellationToken ct);

    Task<Result<SocialMutationEnvelope<SocialPostDto>>> TombstoneAsync(
        string authenticatedCivId, string postId, SocialPostTombstoneRequestDto request, string idempotencyKey, CancellationToken ct);

    /// <summary>Repairs posts whose create process crashed before completing its projections (worker resume).</summary>
    Task RepairIncompleteAsync(CancellationToken ct);
}

/// <summary>World Wire desired-state follow and like mutations.</summary>
public interface ISocialGraphService
{
    Task<Result<SocialMutationEnvelope<SocialFollowDto>>> SetFollowAsync(
        string authenticatedCivId, string accountId, string targetAccountId, SocialFollowSetRequestDto request, string idempotencyKey, CancellationToken ct);

    Task<Result<SocialMutationEnvelope<SocialReactionDto>>> SetLikeAsync(
        string authenticatedCivId, string postId, string accountId, SocialReactionSetRequestDto request, string idempotencyKey, CancellationToken ct);

    /// <summary>Completes follow/like transitions whose event was not appended before a crash (worker resume).</summary>
    Task RepairPendingAsync(CancellationToken ct);
}

/// <summary>World Wire public feeds: global, account posts, and following feed (snapshot-bound).</summary>
public interface ISocialFeedService
{
    Task<Result<SocialPostPageDto>> GlobalAsync(string? cursor, int? limit, CancellationToken ct);

    Task<Result<SocialPostPageDto>> AccountPostsAsync(string accountId, string? cursor, int? limit, CancellationToken ct);

    Task<Result<SocialPostPageDto>> FollowingFeedAsync(string accountId, string? cursor, int? limit, CancellationToken ct);
}
