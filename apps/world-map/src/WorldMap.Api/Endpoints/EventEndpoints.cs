using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using WorldMap.Api.Middleware;
using WorldMap.Api.Results;
using WorldMap.Core.Application;
using WorldMap.Core.Common;
using WorldMap.Core.Contracts;

namespace WorldMap.Api.Endpoints;

/// <summary>Civ event ingestion, the public world-event feed, and the SSE stream.</summary>
internal static class EventEndpoints
{
    public static void MapEventEndpoints(this RouteGroupBuilder group)
    {
        // POST /civilizations/{civId}/events/batch — HMAC-signed at-least-once ingestion.
        group.MapPost("/civilizations/{civId}/events/batch", async (
            string civId,
            EventBatchDto request,
            HttpContext http,
            IEventService events,
            WorldMap.Api.Telemetry.WorldMapMetrics metrics,
            CancellationToken ct) =>
        {
            var auth = EndpointHelpers.Auth(http);
            if (EndpointHelpers.RequireIdempotencyKey(http, auth.IdempotencyKey) is { } bad)
            {
                return bad;
            }

            var result = await events.IngestBatchAsync(civId, request, auth.IdempotencyKey, ct);
            if (result.IsSuccess)
            {
                metrics.RecordEventOutcome("accepted", result.Value.AcceptedCount ?? 0);
                metrics.RecordEventOutcome("duplicate", result.Value.DuplicateCount ?? 0);
            }

            return ApiResults.Ok(result, http);
        })
        .AddEndpointFilter<HmacAuthEndpointFilter>()
        .WithName("ingestEventBatch")
        .WithTags("events");

        // GET /events — public cursor-paginated world-event feed.
        group.MapGet("/events", async (
            string? after,
            int? limit,
            HttpContext http,
            IEventService events,
            CancellationToken ct) =>
        {
            var result = await events.ListWorldEventsAsync(after, limit, ct);
            return ApiResults.Ok(result, http);
        })
        .WithName("listWorldEvents")
        .WithTags("events");

        // GET /stream — public SSE feed of world events (experimental; /events is the baseline).
        group.MapGet("/stream", StreamWorldEvents)
            .WithName("streamWorldEvents")
            .WithTags("events");
    }

    private static async Task StreamWorldEvents(
        string? after,
        HttpContext http,
        IEventService events,
        CancellationToken ct)
    {
        if (!CursorCodec.TryDecode(after, out var cursor))
        {
            http.Response.StatusCode = StatusCodes.Status400BadRequest;
            return;
        }

        http.Response.Headers.ContentType = "text/event-stream";
        http.Response.Headers.CacheControl = "no-cache";
        http.Response.Headers["X-Accel-Buffering"] = "no";

        try
        {
            // Prime + poll. Bounded interval; the /events cursor feed is the interoperable baseline.
            while (!ct.IsCancellationRequested)
            {
                var read = await events.ReadAfterAsync(cursor, 100, ct);
                if (read.IsSuccess)
                {
                    var (items, lastOrdinal) = read.Value;
                    foreach (var evt in items)
                    {
                        var json = JsonSerializer.Serialize(evt, WorldMapJson.Options);
                        await http.Response.WriteAsync($"data: {json}\n\n", Encoding.UTF8, ct);
                    }

                    if (items.Count > 0)
                    {
                        cursor = lastOrdinal;
                        await http.Response.Body.FlushAsync(ct);
                    }
                    else
                    {
                        // Keep-alive comment so proxies don't close an idle stream.
                        await http.Response.WriteAsync(": keep-alive\n\n", Encoding.UTF8, ct);
                        await http.Response.Body.FlushAsync(ct);
                    }
                }

                await Task.Delay(TimeSpan.FromSeconds(1), ct);
            }
        }
        catch (OperationCanceledException)
        {
            // Client disconnected — normal SSE termination.
        }
    }
}
