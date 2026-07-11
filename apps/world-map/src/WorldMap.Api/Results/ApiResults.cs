using System.Net;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using WorldMap.Core.Common;

namespace WorldMap.Api.Results;

/// <summary>
/// Maps the domain <see cref="ErrorInfo"/> to RFC 7807 <c>application/problem+json</c>
/// responses with a stable machine-readable <c>code</c> and a <c>retryable</c> hint, and
/// bridges <see cref="Result{T}"/> to minimal-API <see cref="IResult"/>s.
/// </summary>
public static class ApiResults
{
    private static (int Status, string Code, bool Retryable) Map(ErrorCode code) => code switch
    {
        ErrorCode.ValidationFailed => (400, "validation_failed", false),
        ErrorCode.PayloadTooLarge => (400, "payload_too_large", false),
        ErrorCode.InvalidRequest => (400, "invalid_request", false),
        ErrorCode.InvalidOnboardingToken => (400, "invalid_onboarding_token", false),

        ErrorCode.Unauthorized => (401, "unauthorized", false),
        ErrorCode.InvalidSignature => (401, "invalid_signature", false),
        ErrorCode.ClockSkew => (401, "clock_skew", false),
        ErrorCode.ReplayDetected => (401, "replay_detected", false),

        ErrorCode.CivIdMismatch => (403, "civ_id_mismatch", false),
        ErrorCode.AccessDenied => (403, "access_denied", false),

        ErrorCode.NotFound => (404, "not_found", false),
        ErrorCode.CivilizationNotFound => (404, "civ_not_found", false),
        ErrorCode.InteractionNotFound => (404, "interaction_not_found", false),
        ErrorCode.CommandNotFound => (404, "command_not_found", false),
        ErrorCode.RelationshipNotFound => (404, "relationship_not_found", false),

        ErrorCode.Conflict => (409, "conflict", false),
        ErrorCode.RegistrationConflict => (409, "registration_conflict", false),
        ErrorCode.IdempotencyConflict => (409, "idempotency_conflict", false),
        ErrorCode.ConcurrencyConflict => (409, "concurrency_conflict", true),

        ErrorCode.RateLimited => (429, "rate_limited", true),
        ErrorCode.OperationCancelled => (503, "operation_cancelled", true),

        ErrorCode.StorageError => (500, "storage_error", true),
        ErrorCode.StorageDocumentNotFound => (404, "not_found", false),
        _ => (500, "internal_error", true),
    };

    /// <summary>Builds a problem+json result from an <see cref="ErrorInfo"/>.</summary>
    public static IResult Problem(ErrorInfo error, HttpContext http)
    {
        var (status, code, defaultRetryable) = Map(error.Code);
        var retryable = error.Retryable || defaultRetryable;

        var problem = new ProblemDetails
        {
            Type = "about:blank",
            Title = ((HttpStatusCode)status).ToString(),
            Status = status,
            Detail = error.Message,
        };
        problem.Extensions["code"] = code;
        problem.Extensions["retryable"] = retryable;
        problem.Extensions["traceId"] = http.TraceIdentifier;
        if (error.Errors is { Count: > 0 })
        {
            problem.Extensions["errors"] = error.Errors
                .Select(e => new { pointer = e.Pointer, detail = e.Detail })
                .ToArray();
        }

        return TypedResults.Problem(problem);
    }

    /// <summary>200 OK on success, else problem+json.</summary>
    public static IResult Ok<T>(Result<T> result, HttpContext http) =>
        result.IsSuccess ? TypedResults.Ok(result.Value) : Problem(result.Error, http);
}
