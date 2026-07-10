using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using WorldMap.Api.Middleware;
using WorldMap.Api.Results;
using WorldMap.Core.Application;
using WorldMap.Core.Contracts;

namespace WorldMap.Api.Endpoints;

/// <summary>Civilization onboarding, liveness, and public projection endpoints.</summary>
internal static class CivilizationEndpoints
{
    public static void MapCivilizationEndpoints(this RouteGroupBuilder group)
    {
        // POST /civilizations/register — bootstrap (onboarding token, not HMAC-signed).
        group.MapPost("/civilizations/register", async (
            RegistrationRequestDto request,
            HttpContext http,
            IOnboardingService onboarding,
            WorldMap.Api.Telemetry.WorldMapMetrics metrics,
            CancellationToken ct) =>
        {
            var idempotencyKey = http.Request.Headers.TryGetValue("Idempotency-Key", out var k) ? k.ToString() : string.Empty;
            if (EndpointHelpers.RequireIdempotencyKey(http, idempotencyKey) is { } bad)
            {
                return bad;
            }

            var result = await onboarding.RegisterAsync(request, idempotencyKey, ct);
            if (!result.IsSuccess)
            {
                return ApiResults.Problem(result.Error, http);
            }

            if (!result.Value.Body.Duplicate)
            {
                metrics.RecordRegistration();
            }

            return TypedResults.Created(result.Value.Location, result.Value.Body);
        })
        .WithName("registerCivilization")
        .WithTags("civilizations");

        // POST /civilizations/{civId}/heartbeat — HMAC-signed liveness.
        group.MapPost("/civilizations/{civId}/heartbeat", async (
            string civId,
            HeartbeatDto request,
            HttpContext http,
            ICivilizationService civilizations,
            CancellationToken ct) =>
        {
            var result = await civilizations.HeartbeatAsync(civId, request, ct);
            return ApiResults.Ok(result, http);
        })
        .AddEndpointFilter<HmacAuthEndpointFilter>()
        .WithName("heartbeatCivilization")
        .WithTags("civilizations");

        // GET /civilizations — public cursor-paginated projection list.
        group.MapGet("/civilizations", async (
            string? after,
            int? limit,
            HttpContext http,
            ICivilizationService civilizations,
            CancellationToken ct) =>
        {
            var result = await civilizations.ListAsync(after, limit, ct);
            return ApiResults.Ok(result, http);
        })
        .WithName("listCivilizations")
        .WithTags("civilizations");

        // GET /civilizations/{civId} — public single projection.
        group.MapGet("/civilizations/{civId}", async (
            string civId,
            HttpContext http,
            ICivilizationService civilizations,
            CancellationToken ct) =>
        {
            var result = await civilizations.GetAsync(civId, ct);
            return ApiResults.Ok(result, http);
        })
        .WithName("getCivilization")
        .WithTags("civilizations");
    }
}
