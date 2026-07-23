namespace WorldMap.Core.Common;

/// <summary>
/// Stable, machine-readable error codes for the World runtime. The
/// <see cref="ProblemMapping"/> maps each to the RFC 7807 <c>code</c> string and
/// HTTP status that cross the wire; the enum itself never leaks to clients.
/// </summary>
public enum ErrorCode
{
    // Generic
    InvalidRequest,
    ValidationFailed,
    PayloadTooLarge,
    Unauthorized,
    AccessDenied,
    NotFound,
    Conflict,
    RateLimited,
    OperationCancelled,
    Internal,

    // Auth / signing
    InvalidSignature,
    ReplayDetected,
    ClockSkew,
    CivIdMismatch,

    // Registration
    RegistrationConflict,
    InvalidOnboardingToken,

    // Domain
    CivilizationNotFound,
    InteractionNotFound,
    CommandNotFound,
    RelationshipNotFound,
    IdempotencyConflict,
    ConcurrencyConflict,

    // Persistence
    StorageError,
    StorageDocumentNotFound,

    // World Wire social
    SocialAccountNotFound,
    PostNotFound,
    ForbiddenAccount,
    ForbiddenActor,
    SystemAccountReserved,
    ContentTooLong,
    InvalidSocialContent,
    ReplyDepthExceeded,
    PostTombstoned,
    SelfFollowForbidden,
    OfficialAccountConflict,
    CursorFilterMismatch,
}
