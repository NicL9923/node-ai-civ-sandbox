using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using WorldMap.Api.Middleware;
using WorldMap.Api.Results;
using WorldMap.Core.Application;
using WorldMap.Core.Contracts;

namespace WorldMap.Api.Endpoints;

/// <summary>President-authorized inter-civ contact/message interaction endpoints (HMAC-signed).</summary>
internal static class InteractionEndpoints
{
    public static void MapInteractionEndpoints(this RouteGroupBuilder group)
    {
        // POST /interactions — async submit; 202 Accepted + Location/status URL.
        group.MapPost("/interactions", async (
            InteractionRequestDto request,
            HttpContext http,
            IInteractionService interactions,
            WorldMap.Api.Telemetry.WorldMapMetrics metrics,
            TimeProvider clock,
            CancellationToken ct) =>
        {
            var auth = EndpointHelpers.Auth(http);
            if (EndpointHelpers.RequireIdempotencyKey(http, auth.IdempotencyKey) is { } bad)
            {
                return bad;
            }

            var started = clock.GetTimestamp();
            var result = await interactions.SubmitAsync(auth.CivId, request, auth.IdempotencyKey, ct);
            if (!result.IsSuccess)
            {
                return ApiResults.Problem(result.Error, http);
            }

            metrics.RecordInteractionSubmitted(request.Kind ?? "unknown", result.Value.Body.Duplicate);
            metrics.RecordInteractionLatency(clock.GetElapsedTime(started).TotalMilliseconds);
            return TypedResults.Accepted(result.Value.Location, result.Value.Body);
        })
        .AddEndpointFilter<HmacAuthEndpointFilter>()
        .WithName("submitInteraction")
        .WithTags("interactions");

        // GET /interactions/{interactionId} — status lookup.
        group.MapGet("/interactions/{interactionId}", async (
            string interactionId,
            HttpContext http,
            IInteractionService interactions,
            CancellationToken ct) =>
        {
            var result = await interactions.GetAsync(interactionId, ct);
            return ApiResults.Ok(result, http);
        })
        .AddEndpointFilter<HmacAuthEndpointFilter>()
        .WithName("getInteraction")
        .WithTags("interactions");
    }
}
