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
        WorldMap.Api.Sse.SseBroadcaster broadcaster,
        CancellationToken ct)
    {
        if (!CursorCodec.TryDecode(after, out var cursor))
        {
            http.Response.StatusCode = StatusCodes.Status400BadRequest;
            return;
        }

        using var subscription = broadcaster.Subscribe();
        if (subscription is null)
        {
            http.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
            return;
        }

        http.Response.Headers.ContentType = "text/event-stream";
        http.Response.Headers.CacheControl = "no-cache";
        http.Response.Headers["X-Accel-Buffering"] = "no";

        try
        {
            // Catch-up: drain the durable feed to its head (paging past the first 200), tracking the
            // highest worldsequence sent. The subscription (opened above) has buffered anything
            // committed meanwhile; we then switch to live delivery, de-duplicating by worldsequence.
            long lastSent = cursor;
            while (!ct.IsCancellationRequested)
            {
                var read = await events.ReadAfterAsync(lastSent, 200, ct);
                if (!read.IsSuccess || read.Value.Items.Count == 0)
                {
                    break;
                }

                foreach (var evt in read.Value.Items)
                {
                    await WriteFrameAsync(http, evt, ct);
                }

                lastSent = read.Value.LastOrdinal;
                await http.Response.Body.FlushAsync(ct);
            }

            var reader = subscription.Reader;
            while (!ct.IsCancellationRequested)
            {
                // Heartbeat if no event arrives within the interval so idle proxies stay open.
                using var heartbeat = CancellationTokenSource.CreateLinkedTokenSource(ct);
                heartbeat.CancelAfter(TimeSpan.FromSeconds(15));
                try
                {
                    var evt = await reader.ReadAsync(heartbeat.Token);

                    // Skip anything already delivered during catch-up (overlap window).
                    if (long.TryParse(evt.Worldsequence, out var ws) && ws <= lastSent)
                    {
                        continue;
                    }

                    if (long.TryParse(evt.Worldsequence, out var seq))
                    {
                        lastSent = seq;
                    }

                    await WriteFrameAsync(http, evt, ct);
                    await http.Response.Body.FlushAsync(ct);
                }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                {
                    await http.Response.WriteAsync(": keep-alive\n\n", Encoding.UTF8, ct);
                    await http.Response.Body.FlushAsync(ct);
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Client disconnected — normal SSE termination.
        }
    }

    private static Task WriteFrameAsync(HttpContext http, CloudEventDto evt, CancellationToken ct)
    {
        var json = JsonSerializer.Serialize(evt, WorldMapJson.Options);
        return http.Response.WriteAsync($"data: {json}\n\n", Encoding.UTF8, ct);
    }
}
