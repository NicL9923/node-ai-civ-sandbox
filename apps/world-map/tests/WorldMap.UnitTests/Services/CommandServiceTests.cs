using WorldMap.Core.Common;
using WorldMap.Core.Contracts;
using WorldMap.Core.Domain;

namespace WorldMap.UnitTests.Services;

public sealed class CommandServiceTests
{
    [Fact]
    public async Task PullThenAck_AdvancesLinkedInteractionAndReAckIsDuplicate()
    {
        var world = new TestWorld();
        var (source, target) = await world.SeedCivPairAsync();
        var submitted = await world.Interactions.SubmitAsync(
            source,
            TestWorld.ContactRequest(source, target),
            "submit-1",
            CancellationToken.None);
        var interactionId = submitted.Value.Body.ResourceId!;
        var interaction = await world.InteractionRepository.GetAsync(interactionId, CancellationToken.None);

        var pulled = await world.Command.PullAsync(target, null, 10, CancellationToken.None);

        Assert.True(pulled.IsSuccess);
        var command = Assert.Single(pulled.Value.Items);
        interaction = await world.InteractionRepository.GetAsync(interactionId, CancellationToken.None);
        Assert.Equal(InteractionStatus.Delivered, interaction!.Status);

        var ack = await world.Command.AckAsync(
            target,
            command.Commandid,
            new CommandAckDto { Status = "applied" },
            "ack-1",
            CancellationToken.None);

        Assert.True(ack.IsSuccess);
        Assert.False(ack.Value.Duplicate);
        Assert.Equal("applied", ack.Value.Status);
        interaction = await world.InteractionRepository.GetAsync(interactionId, CancellationToken.None);
        Assert.Equal(InteractionStatus.Acknowledged, interaction!.Status);

        var replay = await world.Command.AckAsync(
            target,
            command.Commandid,
            new CommandAckDto { Status = "rejected" },
            "ack-2",
            CancellationToken.None);

        Assert.True(replay.IsSuccess);
        Assert.True(replay.Value.Duplicate);
        Assert.Equal("applied", replay.Value.Status);
        Assert.Equal(ack.Value.AcknowledgedAt, replay.Value.AcknowledgedAt);
    }

    [Fact]
    public async Task AckAsync_UnknownCommand_ReturnsCommandNotFound()
    {
        var world = new TestWorld();

        var result = await world.Command.AckAsync(
            "civ_a",
            "missing",
            new CommandAckDto { Status = "applied" },
            "ack",
            CancellationToken.None);

        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.CommandNotFound, result.Error.Code);
    }

    [Fact]
    public async Task AckAsync_BadStatus_ReturnsValidationFailed()
    {
        var world = new TestWorld();
        await world.Commands.AddAsync(CreateCommand(), CancellationToken.None);

        var result = await world.Command.AckAsync(
            "civ_a",
            "cmd_1",
            new CommandAckDto { Status = "maybe" },
            "ack",
            CancellationToken.None);

        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.ValidationFailed, result.Error.Code);
    }

    private static Command CreateCommand() => new()
    {
        CommandId = "cmd_1",
        TargetCivId = "civ_a",
        CommandSequence = 1,
        EventId = "evt_1",
        Type = "test.command",
        Source = "/world",
        DeliveredAt = DateTimeOffset.UtcNow,
        CreatedAt = DateTimeOffset.UtcNow,
    };
}
