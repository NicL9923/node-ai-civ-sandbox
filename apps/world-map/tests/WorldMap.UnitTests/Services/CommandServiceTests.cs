using WorldMap.Core.Common;
using WorldMap.Core.Contracts;
using WorldMap.Core.Domain;

namespace WorldMap.UnitTests.Services;

public sealed class CommandServiceTests
{
    [Fact]
    public async Task PullMarksDeliveredAndAppliedAckIsIdempotent()
    {
        var (world, target, interactionId) = await SubmittedInteraction();

        var pulled = await world.Command.PullAsync(target, null, 10, default);
        var command = Assert.Single(pulled.Value.Items);
        Assert.Equal(InteractionStatus.Delivered,
            (await world.InteractionRepository.GetAsync(interactionId, default))!.Status);

        var first = await world.Command.AckAsync(
            target, command.Commandid, new CommandAckDto { Status = "applied" }, "ack-1", default);
        var second = await world.Command.AckAsync(
            target, command.Commandid, new CommandAckDto { Status = "rejected" }, "ack-2", default);

        Assert.True(first.IsSuccess);
        Assert.False(first.Value.Duplicate);
        Assert.True(second.Value.Duplicate);
        Assert.Equal("applied", second.Value.Status);
        Assert.Equal(first.Value.AcknowledgedAt, second.Value.AcknowledgedAt);
        Assert.Equal(InteractionStatus.Acknowledged,
            (await world.InteractionRepository.GetAsync(interactionId, default))!.Status);
    }

    [Fact]
    public async Task RejectedAckRejectsInteraction()
    {
        var (world, target, interactionId) = await SubmittedInteraction();
        var command = Assert.Single((await world.Command.PullAsync(target, null, 10, default)).Value.Items);

        var ack = await world.Command.AckAsync(
            target, command.Commandid, new CommandAckDto { Status = "rejected" }, "ack", default);

        Assert.True(ack.IsSuccess);
        Assert.Equal(InteractionStatus.Rejected,
            (await world.InteractionRepository.GetAsync(interactionId, default))!.Status);
    }

    [Fact]
    public async Task MaintenanceRepairsCrashBetweenAckAndInteractionReconcile()
    {
        var (world, target, interactionId) = await SubmittedInteraction();
        var interaction = await world.InteractionRepository.GetAsync(interactionId, default);

        var transition = await world.Commands.TryAckAsync(
            target, interaction!.CommandId, CommandAckStatus.Applied, world.Clock.GetUtcNow(), default);
        Assert.True(transition.Won);
        Assert.False(transition.Command.AckReconciled);

        await world.Maintenance.SweepAsync(default);

        Assert.Equal(InteractionStatus.Acknowledged,
            (await world.InteractionRepository.GetAsync(interactionId, default))!.Status);
        Assert.True((await world.Commands.GetAsync(target, interaction.CommandId, default))!.AckReconciled);
    }

    [Fact]
    public async Task InvalidAckAndMissingCommandReturnErrors()
    {
        var world = new TestWorld();
        var missing = await world.Command.AckAsync(
            "civ", "missing", new CommandAckDto { Status = "applied" }, "key", default);
        Assert.Equal(ErrorCode.CommandNotFound, missing.Error.Code);

        await world.Commands.EnqueueAsync(CreateCommand("cmd"), default);
        var invalid = await world.Command.AckAsync(
            "civ", "cmd", new CommandAckDto { Status = "maybe" }, "key", default);
        Assert.Equal(ErrorCode.ValidationFailed, invalid.Error.Code);
    }

    private static async Task<(TestWorld World, string Target, string InteractionId)> SubmittedInteraction()
    {
        var world = new TestWorld();
        var (source, target) = await world.SeedCivPairAsync();
        var submitted = await world.Interactions.SubmitAsync(
            source, TestWorld.ContactRequest(source, target), "submit", default);
        return (world, target, submitted.Value.Body.ResourceId!);
    }

    private static Command CreateCommand(string id) => new()
    {
        CommandId = id,
        TargetCivId = "civ",
        EventId = $"event-{id}",
        Type = "test",
        Source = "/world",
        DeliveredAt = DateTimeOffset.UtcNow,
        CreatedAt = DateTimeOffset.UtcNow,
    };
}
