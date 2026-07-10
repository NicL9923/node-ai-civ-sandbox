using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using WorldMap.Core.Abstractions;

namespace WorldMap.Api.Endpoints;

/// <summary>Maps the full federation API under the <c>/world/v1</c> path base plus health/root.</summary>
internal static class WorldMapEndpoints
{
    public static void MapWorldMapApi(this WebApplication app)
    {
        // All federation operations live under /world/v1 (plain-segment paths per the contract).
        var v1 = app.MapGroup("/world/v1");
        v1.MapCivilizationEndpoints();
        v1.MapEventEndpoints();
        v1.MapCommandEndpoints();
        v1.MapInteractionEndpoints();
        v1.MapRelationshipEndpoints();

        // Liveness — independent of dependencies (is the process running?).
        app.MapGet("/health", () => TypedResults.Ok(new { status = "healthy" }))
            .WithName("health")
            .AllowAnonymous();

        // Readiness — probes required backing dependencies (storage/secret/onboarding).
        app.MapGet("/health/ready", async (IReadinessProbe probe, HttpContext http, CancellationToken ct) =>
        {
            var result = await probe.CheckAsync(ct);
            return result.Ready
                ? Microsoft.AspNetCore.Http.Results.Ok(new { status = "ready", detail = result.Detail })
                : Microsoft.AspNetCore.Http.Results.Json(new { status = "not_ready", detail = result.Detail }, statusCode: StatusCodes.Status503ServiceUnavailable);
        })
            .WithName("ready")
            .AllowAnonymous();
    }
}
