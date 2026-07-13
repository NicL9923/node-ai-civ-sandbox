using WorldMap.Core.Common;
using WorldMap.Core.Contracts;
using WorldMap.Core.Domain;

namespace WorldMap.UnitTests.Services;

public sealed class CivilizationServiceTests
{
    [Fact]
    public async Task HeartbeatUpdatesProjectionAndCountsOnlyPullableCommands()
    {
        var world = new TestWorld();
        await world.SeedCivAsync("civ_a");
        await world.Commands.EnqueueAsync(Command("pending"), default);
        await world.Commands.EnqueueAsync(Command("acked"), default);
        await world.Commands.TryAckAsync("civ_a", "acked", CommandAckStatus.Applied, world.Clock.GetUtcNow(), default);
        var projection = new PublicProjectionDto
        {
            CivId = "civ_a",
            DisplayName = "Aurora",
            ProtocolVersion = "1.0",
            Turn = 7,
            Running = true,
            Population = 42,
            UpdatedAt = world.Clock.GetUtcNow(),
        };

        var result = await world.Civilization.HeartbeatAsync(
            "civ_a", new HeartbeatDto { Projection = projection }, default);

        Assert.True(result.IsSuccess);
        Assert.Equal(1, result.Value.PendingCommandCount);
        var stored = await world.Civilizations.GetAsync("civ_a", default);
        Assert.Equal(7, stored!.Turn);
        Assert.Equal(42, stored.Population);
    }

    [Fact]
    public async Task MissingCivilizationReturnsNotFound()
    {
        var result = await new TestWorld().Civilization.GetAsync("missing", default);
        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.CivilizationNotFound, result.Error.Code);
    }

    private static Command Command(string id) => new()
    {
        CommandId = id,
        TargetCivId = "civ_a",
        EventId = $"event-{id}",
        Type = "test",
        Source = "/world",
        DeliveredAt = DateTimeOffset.UtcNow,
        CreatedAt = DateTimeOffset.UtcNow,
    };
}
