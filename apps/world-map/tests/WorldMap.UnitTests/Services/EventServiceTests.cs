using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Application;
using WorldMap.Core.Application.Impl;
using WorldMap.Core.Common;
using WorldMap.Core.Configuration;
using WorldMap.Core.Contracts;
using WorldMap.Infrastructure.InMemory;

namespace WorldMap.UnitTests.Services;

public sealed class EventServiceTests
{
    [Fact]
    public async Task InvalidItemRejectsEntireBatchWithoutPersistence()
    {
        var world = new TestWorld();
        var request = new EventBatchDto
        {
            Events =
            [
                Event("valid", "civ_a"),
                Event("invalid", "civ_a") with { Specversion = "0.3" },
            ],
        };

        var result = await world.Events.IngestBatchAsync("civ_a", request, "batch", default);

        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.ValidationFailed, result.Error.Code);
        Assert.Empty((await world.WorldEvents.ListAsync(0, 10, default)).Items);
    }

    [Theory]
    [InlineData("0.3", "civ_a")]
    [InlineData("1.0", "civ_b")]
    public async Task SpecVersionAndAuthenticatedSourceAreEnforced(string version, string sourceCiv)
    {
        var world = new TestWorld();
        var request = new EventBatchDto { Events = [Event("event", sourceCiv) with { Specversion = version }] };

        var result = await world.Events.IngestBatchAsync("civ_a", request, "batch", default);

        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.ValidationFailed, result.Error.Code);
        Assert.Empty((await world.WorldEvents.ListAsync(0, 10, default)).Items);
    }

    [Fact]
    public async Task ProducerDedupeReturnsOriginalSequenceButDifferentCivilizationsDoNotCollide()
    {
        var world = new TestWorld();
        var sameProducer = new EventBatchDto
        {
            Events =
            [
                Event("first", "civ_a", "dedupe"),
                Event("second", "civ_a", "dedupe"),
            ],
        };

        var first = await world.Events.IngestBatchAsync("civ_a", sameProducer, "batch-a", default);
        var other = await world.Events.IngestBatchAsync(
            "civ_b", new EventBatchDto { Events = [Event("first", "civ_b", "dedupe")] }, "batch-b", default);

        Assert.True(first.IsSuccess);
        Assert.Equal(["accepted", "duplicate"], first.Value.Results.Select(r => r.Status));
        Assert.Equal(first.Value.Results[0].Worldsequence, first.Value.Results[1].Worldsequence);
        Assert.True(other.IsSuccess);
        Assert.NotEqual(first.Value.Results[0].Worldsequence, other.Value.Results[0].Worldsequence);
    }

    [Fact]
    public async Task BatchReplayReturnsIdenticalResultAndDoesNotPersistAgain()
    {
        var world = new TestWorld();
        var request = new EventBatchDto { Events = [Event("event", "civ_a")] };

        var first = await world.Events.IngestBatchAsync("civ_a", request, "same", default);
        var replay = await world.Events.IngestBatchAsync("civ_a", request, "same", default);

        Assert.True(first.IsSuccess);
        Assert.Equivalent(first.Value, replay.Value, strict: true);
        Assert.Single((await world.WorldEvents.ListAsync(0, 10, default)).Items);
    }

    [Fact]
    public async Task CivPayloadIsNeverReflectedIntoPublicFeed()
    {
        var world = new TestWorld();
        var request = new EventBatchDto
        {
            Events = [Event("event", "civ_a") with { Data = new JsonObject { ["secret"] = "private" } }],
        };

        await world.Events.IngestBatchAsync("civ_a", request, "batch", default);
        var listed = await world.Events.ListWorldEventsAsync(null, 10, default);

        Assert.True(listed.IsSuccess);
        Assert.Null(Assert.Single(listed.Value.Items).Data);
    }

    [Fact]
    public async Task OmittedSpecVersionIsRejectedWithoutPersistence()
    {
        var world = new TestWorld();
        var request = new EventBatchDto
        {
            // specversion intentionally omitted -> deserializes to null; must be rejected as required.
            Events = [new CloudEventDto { Id = "event", Type = "civ.turn.completed.v1", Source = "/civilizations/civ_a" }],
        };

        var result = await world.Events.IngestBatchAsync("civ_a", request, "batch", default);

        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.ValidationFailed, result.Error.Code);
        Assert.Empty((await world.WorldEvents.ListAsync(0, 10, default)).Items);
    }

    [Fact]
    public async Task PublicFeedPageIsBoundedByByteBudgetAndCursorDrainsEveryEventOnce()
    {
        // A tiny per-page byte cap forces truncation even though the item-count limit is generous.
        var svc = SmallPageService(maxPublicPageBytes: 250, out var worldEvents, out _);
        const int total = 6;
        var batch = new EventBatchDto
        {
            Events = Enumerable.Range(0, total).Select(i => Event($"e{i}", "civ_a", $"k{i}")).ToList(),
        };
        Assert.True((await svc.IngestBatchAsync("civ_a", batch, "batch", default)).IsSuccess);

        // First page is byte-bounded: fewer than all events, at least one, within budget, cursor set.
        var first = await svc.ListWorldEventsAsync(null, 100, default);
        Assert.True(first.IsSuccess);
        Assert.InRange(first.Value.Items.Count, 1, total - 1);
        Assert.NotNull(first.Value.NextCursor);
        Assert.True(PageBytes(first.Value.Items) <= 250);

        // Following the cursor drains the whole feed exactly once, in ascending worldsequence order.
        var seen = new List<long>();
        var page = first.Value;
        string? cursor = null;
        for (var guard = 0; guard < total + 2; guard++)
        {
            seen.AddRange(page.Items.Select(e => long.Parse(e.Worldsequence!)));
            if (page.NextCursor is null)
            {
                break;
            }

            cursor = page.NextCursor;
            page = (await svc.ListWorldEventsAsync(cursor, 100, default)).Value;
        }

        Assert.Equal(total, seen.Count);
        Assert.Equal(seen.OrderBy(x => x).ToList(), seen); // strictly forward, no re-delivery
        Assert.Equal(total, seen.Distinct().Count());
        Assert.Equal(total, (await worldEvents.ListAsync(0, 100, default)).Items.Count);
    }

    private static long PageBytes(IReadOnlyList<CloudEventDto> items) =>
        items.Sum(i => (long)System.Text.Encoding.UTF8.GetByteCount(
            System.Text.Json.JsonSerializer.Serialize(i, WorldMapJson.Options)));

    private static EventService SmallPageService(
        int maxPublicPageBytes,
        out InMemoryWorldEventRepository worldEvents,
        out FakeTimeProvider clock)
    {
        clock = new FakeTimeProvider(new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero));
        worldEvents = new InMemoryWorldEventRepository();
        var options = Options.Create(new WorldMapOptions
        {
            Interaction = new InteractionOptions { IdempotencyTtlSeconds = 5 },
            Events = new EventOptions { MaxBatchSize = 500, MaxPublicDataBytes = 4096, MaxPublicPageBytes = maxPublicPageBytes },
        });
        var idempotency = new IdempotencyExecutor(new InMemoryIdempotencyStore(clock), clock, NullLogger<IdempotencyExecutor>.Instance);
        return new EventService(worldEvents, idempotency, new NoOpWorldEventSink(), clock, options, NullLogger<EventService>.Instance);
    }

    private static CloudEventDto Event(string id, string civId, string? dedupe = null) => new()
    {
        Id = id,
        Specversion = "1.0",
        Type = "civ.turn.completed.v1",
        Source = $"/civilizations/{civId}",
        Idempotencykey = dedupe,
    };
}
