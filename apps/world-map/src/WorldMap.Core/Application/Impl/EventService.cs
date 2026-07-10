using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Common;
using WorldMap.Core.Configuration;
using WorldMap.Core.Contracts;
using WorldMap.Core.Domain;

namespace WorldMap.Core.Application.Impl;

/// <summary>
/// Civ event ingestion and the citizen-safe public world-event feed. The ENTIRE batch is validated
/// before any effect (a single invalid item fails the whole batch with zero persistence). Each event
/// must originate from the authenticated civ's namespace. Dedupe is atomic and producer-scoped
/// (identity = hash(authenticated civId + idempotencykey|source+id)), so civs may reuse raw event
/// ids without collision. Batch-level idempotency replays the exact result. Public projections never
/// reflect arbitrary producer <c>data</c>.
/// </summary>
public sealed class EventService(
    IWorldEventRepository worldEvents,
    IdempotencyExecutor idempotency,
    IWorldEventSink sink,
    TimeProvider clock,
    IOptions<WorldMapOptions> options,
    ILogger<EventService> logger) : IEventService
{
    private const string SpecVersion = "1.0";
    private readonly WorldMapOptions _options = options.Value;

    public async Task<Result<EventBatchResultDto>> IngestBatchAsync(
        string civId,
        EventBatchDto request,
        string idempotencyKey,
        CancellationToken ct)
    {
        var expectedSource = $"/civilizations/{civId}";
        var validation = Validate(request, expectedSource);
        if (validation is not null)
        {
            return validation;
        }

        var scope = $"events:{civId}:{idempotencyKey}";
        var fingerprint = RequestFingerprint.Of(request);
        var ttl = TimeSpan.FromSeconds(_options.Interaction.IdempotencyTtlSeconds);

        var outcome = await idempotency.ExecuteAsync<EventBatchResultDto>(
            scope,
            fingerprint,
            ttl,
            innerCt => IngestAsync(civId, request, innerCt),
            body => body,
            ct);

        return outcome.IsSuccess ? outcome.Value.Body : outcome.Error;
    }

    private async Task<Result<OperationOutcome<EventBatchResultDto>>> IngestAsync(
        string civId,
        EventBatchDto request,
        CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        var results = new List<EventBatchItemResultDto>(request.Events!.Count);
        var accepted = 0;
        var duplicates = 0;

        foreach (var evt in request.Events)
        {
            // Producer-scoped dedupe identity: never the raw event id alone.
            var producerKey = !string.IsNullOrEmpty(evt!.Idempotencykey) ? evt.Idempotencykey : $"{evt.Source}|{evt.Id}";
            var dedupeKey = $"civ:{civId}:{Deterministic.ShortHash(producerKey!)}";

            var append = await worldEvents.AppendAsync(new WorldEvent
            {
                EventId = evt.Id!,
                Type = evt.Type!,
                Source = evt.Source!,
                Subject = evt.Subject,
                Time = evt.Time,
                PublicData = null, // civ-ingested data is never surfaced publicly.
                CorrelationId = evt.Correlationid,
                CausationId = evt.Causationid,
                SourceCiv = civId,
                DedupeKey = dedupeKey,
                CreatedAt = now,
            }, ct);

            if (append.WasDuplicate)
            {
                duplicates++;
                results.Add(new EventBatchItemResultDto
                {
                    Id = evt.Id!,
                    Status = EventIngestStatus.Duplicate.ToWire(),
                    Worldsequence = append.Event.Worldsequence.ToString(),
                });
            }
            else
            {
                accepted++;
                sink.Publish(append.Event.ToPublicDto());
                results.Add(new EventBatchItemResultDto
                {
                    Id = evt.Id!,
                    Status = EventIngestStatus.Accepted.ToWire(),
                    Worldsequence = append.Event.Worldsequence.ToString(),
                });
            }
        }

        var result = new EventBatchResultDto
        {
            AcceptedCount = accepted,
            DuplicateCount = duplicates,
            Results = results,
        };

        logger.LogDebug("Ingested batch from {CivId}: {Accepted} accepted, {Duplicates} duplicate.", civId, accepted, duplicates);
        return new OperationOutcome<EventBatchResultDto>(result, 200, null);
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
            Items = page.Items.Select(e => e.ToPublicDto()).ToList(),
            NextCursor = page.NextOrdinal is { } o ? CursorCodec.Encode(o) : null,
        };
    }

    public async Task<Result<(IReadOnlyList<CloudEventDto> Items, long LastOrdinal)>> ReadAfterAsync(
        long afterOrdinal,
        int limit,
        CancellationToken ct)
    {
        var page = await worldEvents.ListAsync(afterOrdinal, limit, ct);
        var items = page.Items.Select(e => e.ToPublicDto()).ToList();
        var last = page.Items.Count > 0 ? page.Items[^1].Worldsequence : afterOrdinal;
        return (items, last);
    }

    /// <summary>Validates the entire batch. Returns an error (no persistence) on the first failure.</summary>
    private ErrorInfo? Validate(EventBatchDto request, string expectedSource)
    {
        if (request.Events is null || request.Events.Count == 0)
        {
            return ErrorResult.Create(ErrorCode.ValidationFailed, "Event batch must contain at least one event.",
                errors: [new FieldError("/events", "events must contain 1..N items.")]);
        }

        if (request.Events.Count > _options.Events.MaxBatchSize)
        {
            return ErrorResult.Create(ErrorCode.ValidationFailed, $"Event batch exceeds the maximum of {_options.Events.MaxBatchSize} events.");
        }

        for (var i = 0; i < request.Events.Count; i++)
        {
            var evt = request.Events[i];
            if (evt is null)
            {
                return ErrorResult.Create(ErrorCode.ValidationFailed, "Event batch contains a null item.",
                    errors: [new FieldError($"/events/{i}", "event must not be null.")]);
            }

            if (string.IsNullOrEmpty(evt.Id) || string.IsNullOrEmpty(evt.Type) || string.IsNullOrEmpty(evt.Source))
            {
                return ErrorResult.Create(ErrorCode.ValidationFailed, "Each event requires id, type and source.",
                    errors: [new FieldError($"/events/{i}", "id, type and source are required.")]);
            }

            if (evt.Specversion != SpecVersion)
            {
                return ErrorResult.Create(ErrorCode.ValidationFailed, "Each event's specversion must be exactly '1.0'.",
                    errors: [new FieldError($"/events/{i}/specversion", "specversion must be '1.0'.")]);
            }

            if (evt.Source != expectedSource)
            {
                return ErrorResult.Create(ErrorCode.ValidationFailed, "Event source must match the authenticated civilization.",
                    errors: [new FieldError($"/events/{i}/source", $"source must be '{expectedSource}'.")]);
            }

            if (evt.Data is not null and not JsonObject)
            {
                return ErrorResult.Create(ErrorCode.ValidationFailed, "Event data must be a JSON object when present.",
                    errors: [new FieldError($"/events/{i}/data", "data must be an object.")]);
            }
        }

        return null;
    }
}
