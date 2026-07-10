using System.Text.Json.Nodes;
using WorldMap.Core.Common;
using WorldMap.Core.Contracts;

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

    private static CloudEventDto Event(string id, string civId, string? dedupe = null) => new()
    {
        Id = id,
        Specversion = "1.0",
        Type = "civ.turn.completed.v1",
        Source = $"/civilizations/{civId}",
        Idempotencykey = dedupe,
    };
}
