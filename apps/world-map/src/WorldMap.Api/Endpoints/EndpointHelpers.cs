using Microsoft.AspNetCore.Http;
using WorldMap.Api.Middleware;
using WorldMap.Api.Results;
using WorldMap.Core.Common;

namespace WorldMap.Api.Endpoints;

/// <summary>Shared helpers for endpoint handlers.</summary>
internal static class EndpointHelpers
{
    /// <summary>Reads the authenticated context established by the HMAC filter.</summary>
    public static AuthContext Auth(HttpContext http) =>
        (AuthContext)http.Items[AuthContext.HttpContextItemKey]!;

    /// <summary>
    /// Ensures an <c>Idempotency-Key</c> was supplied for a mutating operation that
    /// requires one, returning a 400 problem result if absent.
    /// </summary>
    public static IResult? RequireIdempotencyKey(HttpContext http, string idempotencyKey)
    {
        if (string.IsNullOrEmpty(idempotencyKey))
        {
            return ApiResults.Problem(
                ErrorResult.Create(ErrorCode.ValidationFailed, "The Idempotency-Key header is required for this operation.",
                    errors: [new FieldError("/headers/Idempotency-Key", "Idempotency-Key is required.")]),
                http);
        }

        return null;
    }
}
