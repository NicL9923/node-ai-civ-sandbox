using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

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

        // Liveness/readiness for orchestration.
        app.MapGet("/health", () => TypedResults.Ok(new { status = "healthy" }))
            .WithName("health")
            .AllowAnonymous();

        app.MapGet("/health/ready", () => TypedResults.Ok(new { status = "ready" }))
            .WithName("ready")
            .AllowAnonymous();
    }
}
