using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using WorldMap.Api.Middleware;
using WorldMap.Api.Results;
using WorldMap.Core.Application;
using WorldMap.Core.Contracts;

namespace WorldMap.Api.Endpoints;

/// <summary>World-originated command pull + ack endpoints (HMAC-signed).</summary>
internal static class CommandEndpoints
{
    public static void MapCommandEndpoints(this RouteGroupBuilder group)
    {
        // GET /civilizations/{civId}/commands — forward-only pull.
        group.MapGet("/civilizations/{civId}/commands", async (
            string civId,
            string? after,
            int? limit,
            HttpContext http,
            ICommandService commands,
            CancellationToken ct) =>
        {
            var result = await commands.PullAsync(civId, after, limit, ct);
            return ApiResults.Ok(result, http);
        })
        .AddEndpointFilter<HmacAuthEndpointFilter>()
        .WithName("pullCommands")
        .WithTags("commands");

        // POST /civilizations/{civId}/commands/{commandId}/ack — idempotent acknowledgment.
        group.MapPost("/civilizations/{civId}/commands/{commandId}/ack", async (
            string civId,
            string commandId,
            CommandAckDto request,
            HttpContext http,
            ICommandService commands,
            WorldMap.Api.Telemetry.WorldMapMetrics metrics,
            CancellationToken ct) =>
        {
            var auth = EndpointHelpers.Auth(http);
            if (EndpointHelpers.RequireIdempotencyKey(http, auth.IdempotencyKey) is { } bad)
            {
                return bad;
            }

            var result = await commands.AckAsync(civId, commandId, request, auth.IdempotencyKey, ct);
            if (result.IsSuccess)
            {
                metrics.RecordCommandAck(result.Value.Status);
            }

            return ApiResults.Ok(result, http);
        })
        .AddEndpointFilter<HmacAuthEndpointFilter>()
        .WithName("ackCommand")
        .WithTags("commands");
    }
}
