using System.Text.Json;
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
            // Producer-scoped dedupe identity with an explicit namespace discriminator and a NUL
            // separator, so an idempotency key can never collide with a source+id fallback (or with
            // a crafted value that mimics the other form). Never the raw event id alone.
            var rawIdentity = !string.IsNullOrEmpty(evt!.Idempotencykey)
                ? $"idem\0{evt.Idempotencykey}"
                : $"source-id\0{evt.Source}\0{evt.Id}";
            var dedupeKey = $"civ:{civId}:{Deterministic.ShortHash(rawIdentity)}";

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

        // Bound the public page by aggregate serialized bytes as well as item count. Each event's
        // public data is already capped at append time; this caps the whole page so a burst of
        // max-size events can't produce an unbounded response. Always emit at least one item so the
        // cursor makes forward progress; on truncation the cursor points at the last included event.
        var maxBytes = _options.Events.MaxPublicPageBytes;
        var items = new List<CloudEventDto>(page.Items.Count);
        long budget = 0;
        long? lastIncluded = null;
        var truncated = false;

        foreach (var evt in page.Items)
        {
            var dto = evt.ToPublicDto();
            var size = System.Text.Encoding.UTF8.GetByteCount(JsonSerializer.Serialize(dto, WorldMapJson.Options));
            if (items.Count > 0 && budget + size > maxBytes)
            {
                truncated = true;
                break;
            }

            items.Add(dto);
            budget += size;
            lastIncluded = evt.Worldsequence;
        }

        var nextCursor = truncated
            ? CursorCodec.Encode(lastIncluded!.Value)
            : page.NextOrdinal is { } o ? CursorCodec.Encode(o) : null;

        return new EventPageDto
        {
            Items = items,
            NextCursor = nextCursor,
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

        // Aggregate input size guard (before any per-event work or persistence).
        var batchBytes = Utf8Bytes(request);
        if (batchBytes > _options.Events.MaxBatchBytes)
        {
            return ErrorResult.Create(ErrorCode.PayloadTooLarge,
                $"Event batch is {batchBytes} bytes, exceeding the maximum of {_options.Events.MaxBatchBytes}.",
                errors: [new FieldError("/events", "batch is too large.")]);
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

            if (SizeError(evt, i) is { } sizeError)
            {
                return sizeError;
            }
        }

        return null;
    }

    /// <summary>
    /// Bounds a single event's field lengths, extension count, full accepted envelope size, and the
    /// size of its derived public projection — all measured BEFORE any sequence allocation or
    /// persistence, so an oversized event is rejected with zero side effects and every event that is
    /// accepted is guaranteed to fit the Cosmos item and public feed/SSE budgets.
    /// </summary>
    private ErrorInfo? SizeError(CloudEventDto evt, int index)
    {
        var opts = _options.Events;

        foreach (var (field, value) in new[]
                 {
                     ("id", evt.Id), ("type", evt.Type), ("source", evt.Source), ("subject", evt.Subject),
                     ("correlationid", evt.Correlationid), ("causationid", evt.Causationid), ("idempotencykey", evt.Idempotencykey),
                 })
        {
            if (value is not null && value.Length > opts.MaxFieldChars)
            {
                return ErrorResult.Create(ErrorCode.PayloadTooLarge,
                    $"Event field '{field}' exceeds {opts.MaxFieldChars} characters.",
                    errors: [new FieldError($"/events/{index}/{field}", "field is too long.")]);
            }
        }

        if (evt.Extensions is { } ext && ext.Count > opts.MaxExtensions)
        {
            return ErrorResult.Create(ErrorCode.PayloadTooLarge,
                $"Event has {ext.Count} extension attributes, exceeding the maximum of {opts.MaxExtensions}.",
                errors: [new FieldError($"/events/{index}", "too many extension attributes.")]);
        }

        var envelopeBytes = Utf8Bytes(evt);
        if (envelopeBytes > opts.MaxEventBytes)
        {
            return ErrorResult.Create(ErrorCode.PayloadTooLarge,
                $"Event is {envelopeBytes} bytes, exceeding the maximum of {opts.MaxEventBytes}.",
                errors: [new FieldError($"/events/{index}", "event is too large.")]);
        }

        // The derived public projection must also fit the per-event public budget (defense in depth;
        // civ-ingested events carry no public data, so this is normally tiny).
        var publicBytes = Utf8Bytes(ToPublicPreview(evt));
        if (publicBytes > opts.MaxEventBytes)
        {
            return ErrorResult.Create(ErrorCode.PayloadTooLarge,
                "Event's public projection exceeds the maximum event size.",
                errors: [new FieldError($"/events/{index}", "public projection is too large.")]);
        }

        return null;
    }

    /// <summary>The public projection an ingested event would receive (metadata only; never producer data).</summary>
    private static CloudEventDto ToPublicPreview(CloudEventDto evt) => new()
    {
        Id = evt.Id!,
        Specversion = SpecVersion,
        Type = evt.Type!,
        Source = evt.Source!,
        Subject = evt.Subject,
        Time = evt.Time,
        Correlationid = evt.Correlationid,
        Causationid = evt.Causationid,
    };

    private static int Utf8Bytes<T>(T value) =>
        System.Text.Encoding.UTF8.GetByteCount(System.Text.Json.JsonSerializer.Serialize(value, WorldMapJson.Options));
}
