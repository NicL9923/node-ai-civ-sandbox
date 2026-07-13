using WorldMap.Core.Abstractions;
using WorldMap.Core.Domain;
using WorldMap.Infrastructure.InMemory;

namespace WorldMap.UnitTests.Infrastructure;

public sealed class AtomicRepositoryTests
{
    [Fact]
    public async Task WorldEvents_ParallelAppendsAreGaplessAndDedupeReturnsOriginal()
    {
        var repository = new InMemoryWorldEventRepository();
        var appends = await Task.WhenAll(Enumerable.Range(0, 500)
            .Select(i => repository.AppendAsync(Event($"event-{i}", $"dedupe-{i}"), default)));

        var sequences = appends.Select(a => a.Event.Worldsequence).Order().ToArray();
        Assert.Equal(Enumerable.Range(1, 500).Select(i => (long)i), sequences);
        Assert.Equal(500, sequences.Distinct().Count());

        var duplicate = await repository.AppendAsync(Event("changed-id", "dedupe-123"), default);
        Assert.True(duplicate.WasDuplicate);
        Assert.Equal(appends.Single(a => a.Event.DedupeKey == "dedupe-123").Event.Worldsequence,
            duplicate.Event.Worldsequence);

        var listed = await repository.ListAsync(0, 1000, default);
        Assert.Equal(Enumerable.Range(1, 500).Select(i => (long)i),
            listed.Items.Select(e => e.Worldsequence));
    }

    [Fact]
    public async Task Commands_ParallelEnqueueIsPerCivGaplessAndIdempotent()
    {
        var repository = new InMemoryCommandRepository(TimeProvider.System);
        var enqueued = await Task.WhenAll(Enumerable.Range(0, 500)
            .Select(i => repository.EnqueueAsync(Command($"cmd-{i}"), default)));

        Assert.Equal(500, enqueued.Select(c => c.CommandSequence).Distinct().Count());
        Assert.Equal(Enumerable.Range(1, 500).Select(i => (long)i),
            enqueued.Select(c => c.CommandSequence).Order());

        var duplicate = await repository.EnqueueAsync(Command("cmd-123"), default);
        Assert.Equal(enqueued.Single(c => c.CommandId == "cmd-123").CommandSequence, duplicate.CommandSequence);
        Assert.Equal(500, (await repository.PullAsync("target", 0, 1000, default)).Count);
    }

    [Fact]
    public async Task Commands_PullFiltersTerminalAndExpiredAndMarkExpiredIsNotPullable()
    {
        var repository = new InMemoryCommandRepository(TimeProvider.System);
        await repository.EnqueueAsync(Command("pullable"), default);
        await repository.EnqueueAsync(Command("acked"), default);
        await repository.EnqueueAsync(Command("expired"), default);
        await repository.TryAckAsync("target", "acked", CommandAckStatus.Applied, DateTimeOffset.UtcNow, default);
        await repository.MarkExpiredAsync("target", "expired", default);

        var pulled = await repository.PullAsync("target", 0, 10, default);

        Assert.Equal("pullable", Assert.Single(pulled).CommandId);
        Assert.False((await repository.GetAsync("target", "expired", default))!.IsPullable);
    }

    [Fact]
    public async Task Commands_ConcurrentAck_FirstWinsAndSecondSeesAuthoritativeStatus()
    {
        var repository = new InMemoryCommandRepository(TimeProvider.System);
        await repository.EnqueueAsync(Command("cmd"), default);
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        async Task<CommandAckTransition> Ack(CommandAckStatus status)
        {
            await gate.Task;
            return await repository.TryAckAsync("target", "cmd", status, DateTimeOffset.UtcNow, default);
        }

        var attempts = new[] { Ack(CommandAckStatus.Applied), Ack(CommandAckStatus.Rejected) };
        gate.SetResult();
        var results = await Task.WhenAll(attempts);

        Assert.Single(results, r => r.Won);
        Assert.Single(results, r => !r.Won);
        Assert.Equal(results.Single(r => r.Won).Command.AckStatus, results.Single(r => !r.Won).Command.AckStatus);
    }

    private static WorldEvent Event(string id, string dedupe) => new()
    {
        EventId = id,
        Type = "test",
        Source = "/world",
        DedupeKey = dedupe,
        CreatedAt = DateTimeOffset.UtcNow,
    };

    private static Command Command(string id) => new()
    {
        CommandId = id,
        TargetCivId = "target",
        EventId = $"event-{id}",
        Type = "test",
        Source = "/world",
        DeliveredAt = DateTimeOffset.UtcNow,
        CreatedAt = DateTimeOffset.UtcNow,
    };
}
