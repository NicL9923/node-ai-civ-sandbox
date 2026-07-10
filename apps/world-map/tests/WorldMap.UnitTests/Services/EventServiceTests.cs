using WorldMap.Core.Common;
using WorldMap.Core.Contracts;

namespace WorldMap.UnitTests.Services;

public sealed class EventServiceTests
{
    [Fact]
    public async Task IngestBatchAsync_RepeatedEventIdempotencyKey_IsDuplicateWithSameSequence()
    {
        var world = new TestWorld();
        var request = new EventBatchDto
        {
            Events =
            [
                Event("evt-1", "event-dedupe"),
                Event("evt-2", "event-dedupe"),
            ],
        };

        var result = await world.Events.IngestBatchAsync("civ_a", request, "batch-1", CancellationToken.None);

        Assert.True(result.IsSuccess);
        Assert.Equal("accepted", result.Value.Results[0].Status);
        Assert.Equal("duplicate", result.Value.Results[1].Status);
        Assert.Equal(result.Value.Results[0].Worldsequence, result.Value.Results[1].Worldsequence);
        Assert.Equal(1, result.Value.AcceptedCount);
        Assert.Equal(1, result.Value.DuplicateCount);
    }

    [Fact]
    public async Task IngestBatchAsync_DistinctEvents_GetIncreasingSequences()
    {
        var world = new TestWorld();
        var request = new EventBatchDto
        {
            Events = [Event("evt-1", "dedupe-1"), Event("evt-2", "dedupe-2")],
        };

        var result = await world.Events.IngestBatchAsync("civ_a", request, "batch-1", CancellationToken.None);

        Assert.True(result.IsSuccess);
        var sequences = result.Value.Results.Select(r => long.Parse(r.Worldsequence!)).ToArray();
        Assert.True(sequences[1] > sequences[0]);
    }

    [Fact]
    public async Task IngestBatchAsync_BatchIdempotencyReplay_ReturnsIdenticalResult()
    {
        var world = new TestWorld();
        var request = new EventBatchDto { Events = [Event("evt-1", "dedupe-1")] };

        var first = await world.Events.IngestBatchAsync("civ_a", request, "same-batch", CancellationToken.None);
        var replay = await world.Events.IngestBatchAsync("civ_a", request, "same-batch", CancellationToken.None);

        Assert.True(first.IsSuccess);
        Assert.True(replay.IsSuccess);
        Assert.Equivalent(first.Value, replay.Value, strict: true);
    }

    [Fact]
    public async Task IngestBatchAsync_EmptyEvents_ReturnsValidationFailed()
    {
        var world = new TestWorld();

        var result = await world.Events.IngestBatchAsync(
            "civ_a",
            new EventBatchDto { Events = [] },
            "batch-empty",
            CancellationToken.None);

        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.ValidationFailed, result.Error.Code);
    }

    private static CloudEventDto Event(string id, string idempotencyKey) => new()
    {
        Id = id,
        Type = "civ.turn.completed.v1",
        Source = "/civilizations/civ_a",
        Idempotencykey = idempotencyKey,
    };
}
