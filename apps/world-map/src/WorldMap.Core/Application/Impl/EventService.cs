using System.Text.Json;
using Microsoft.Extensions.Logging;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Common;
using WorldMap.Core.Contracts;
using WorldMap.Core.Domain;
using WorldMap.Core.Sequencing;

namespace WorldMap.Core.Application.Impl;

/// <summary>
/// Civ event ingestion (at-least-once, per-event dedupe) and the public world-event feed.
/// Each accepted event is assigned a monotonic <c>worldsequence</c> and appended to the
/// ordered ledger. Dedupe key is the CloudEvents <c>idempotencykey</c>, else <c>source+id</c>.
/// </summary>
public sealed class EventService(
    IWorldEventRepository worldEvents,
    IIdempotencyStore idempotency,
    ISequenceAllocator sequence,
    TimeProvider clock,
    ILogger<EventService> logger) : IEventService
{
    private const int MaxBatch = 500;

    public async Task<Result<EventBatchResultDto>> IngestBatchAsync(
        string civId,
        EventBatchDto request,
        string idempotencyKey,
        CancellationToken ct)
    {
        if (request.Events is null || request.Events.Count == 0)
        {
            return ErrorResult.Create(ErrorCode.ValidationFailed, "Event batch must contain at least one event.",
                errors: [new FieldError("/events", "events must contain 1..500 items.")]);
        }

        if (request.Events.Count > MaxBatch)
        {
            return ErrorResult.Create(ErrorCode.ValidationFailed, $"Event batch exceeds the maximum of {MaxBatch} events.");
        }

        var scope = $"events:{civId}:{idempotencyKey}";
        var replay = await idempotency.GetAsync(scope, ct);
        if (replay is not null)
        {
            return JsonSerializer.Deserialize<EventBatchResultDto>(replay.ResponseJson, WorldMapJson.Options)!;
        }

        var now = clock.GetUtcNow();
        var results = new List<EventBatchItemResultDto>(request.Events.Count);
        var accepted = 0;
        var duplicates = 0;

        foreach (var evt in request.Events)
        {
            if (string.IsNullOrEmpty(evt.Id) || string.IsNullOrEmpty(evt.Type) || string.IsNullOrEmpty(evt.Source))
            {
                results.Add(new EventBatchItemResultDto
                {
                    Id = evt.Id ?? string.Empty,
                    Status = EventIngestStatus.Rejected.ToWire(),
                    Problem = JsonSerializer.SerializeToNode(new
                    {
                        type = "about:blank",
                        title = "Invalid event",
                        status = 400,
                        code = "validation_failed",
                        detail = "id, type and source are required.",
                        retryable = false,
                    }, WorldMapJson.Options),
                });
                continue;
            }

            var dedupeKey = !string.IsNullOrEmpty(evt.Idempotencykey)
                ? evt.Idempotencykey
                : $"{evt.Source}|{evt.Id}";

            var existing = await worldEvents.GetByDedupeAsync(dedupeKey, ct);
            if (existing is not null)
            {
                duplicates++;
                results.Add(new EventBatchItemResultDto
                {
                    Id = evt.Id,
                    Status = EventIngestStatus.Duplicate.ToWire(),
                    Worldsequence = existing.Worldsequence.ToString(),
                });
                continue;
            }

            var ws = await sequence.NextWorldSequenceAsync(ct);
            await worldEvents.AddAsync(new WorldEvent
            {
                EventId = evt.Id,
                Worldsequence = ws,
                Type = evt.Type,
                Source = evt.Source,
                Subject = evt.Subject,
                Time = evt.Time,
                Datacontenttype = evt.Datacontenttype,
                Dataschema = evt.Dataschema,
                Data = evt.Data?.DeepClone(),
                CorrelationId = evt.Correlationid,
                CausationId = evt.Causationid,
                IdempotencyKey = evt.Idempotencykey,
                SourceCiv = civId,
                DedupeKey = dedupeKey,
                CreatedAt = now,
            }, ct);

            accepted++;
            results.Add(new EventBatchItemResultDto
            {
                Id = evt.Id,
                Status = EventIngestStatus.Accepted.ToWire(),
                Worldsequence = ws.ToString(),
            });
        }

        var result = new EventBatchResultDto
        {
            AcceptedCount = accepted,
            DuplicateCount = duplicates,
            Results = results,
        };

        await idempotency.PutIfAbsentAsync(new IdempotencyRecord
        {
            Scope = scope,
            ResponseJson = JsonSerializer.Serialize(result, WorldMapJson.Options),
            StatusCode = 200,
            CreatedAt = now,
            ExpiresAt = now.AddHours(24),
        }, ct);

        logger.LogDebug("Ingested batch from {CivId}: {Accepted} accepted, {Duplicates} duplicate.", civId, accepted, duplicates);
        return result;
    }

    public async Task<Result<EventPageDto>> ListWorldEventsAsync(string? after, int? limit, CancellationToken ct)
    {
        if (!CursorCodec.TryDecode(after, out var afterOrdinal))
        {
            return ErrorResult.Create(ErrorCode.ValidationFailed, "Invalid 'after' cursor.");
        }

        var page = await worldEvents.ListAsync(afterOrdinal, Pagination.ClampLimit(limit), ct);
        return new EventPageDto
        {
            Items = page.Items.Select(e => e.ToDto()).ToList(),
            NextCursor = page.NextOrdinal is { } o ? CursorCodec.Encode(o) : null,
        };
    }

    public async Task<Result<(IReadOnlyList<CloudEventDto> Items, long LastOrdinal)>> ReadAfterAsync(
        long afterOrdinal,
        int limit,
        CancellationToken ct)
    {
        var page = await worldEvents.ListAsync(afterOrdinal, limit, ct);
        var items = page.Items.Select(e => e.ToDto()).ToList();
        var last = page.Items.Count > 0 ? page.Items[^1].Worldsequence : afterOrdinal;
        return (items, last);
    }
}
