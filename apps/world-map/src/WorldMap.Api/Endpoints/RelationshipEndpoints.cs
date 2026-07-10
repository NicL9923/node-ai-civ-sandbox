using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using WorldMap.Api.Results;
using WorldMap.Core.Application;

namespace WorldMap.Api.Endpoints;

/// <summary>Public relationship projection endpoint.</summary>
internal static class RelationshipEndpoints
{
    public static void MapRelationshipEndpoints(this RouteGroupBuilder group)
    {
        // GET /relationships — list, or single-pair lookup with civA+civB.
        group.MapGet("/relationships", async (
            string? after,
            int? limit,
            string? civA,
            string? civB,
            HttpContext http,
            IRelationshipService relationships,
            CancellationToken ct) =>
        {
            var result = await relationships.ListAsync(after, limit, civA, civB, ct);
            return ApiResults.Ok(result, http);
        })
        .WithName("listRelationships")
        .WithTags("relationships");
    }
}
