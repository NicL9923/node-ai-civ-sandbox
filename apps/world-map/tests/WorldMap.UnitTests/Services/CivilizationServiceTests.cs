using WorldMap.Core.Common;
using WorldMap.Core.Contracts;
using WorldMap.Core.Domain;

namespace WorldMap.UnitTests.Services;

public sealed class CivilizationServiceTests
{
    [Fact]
    public async Task HeartbeatAsync_UpdatesProjectionAndReturnsPendingCount()
    {
        var world = new TestWorld();
        await world.SeedCivAsync("civ_a", 1);
        await world.Commands.AddAsync(CreateCommand("cmd_1", "civ_a"), CancellationToken.None);
        var projection = new PublicProjectionDto
        {
            CivId = "civ_a",
            DisplayName = "Aurora",
            ProtocolVersion = "1.0",
            Turn = 12,
            Running = true,
            Population = 345,
            UpdatedAt = world.Clock.GetUtcNow(),
        };

        var result = await world.Civilization.HeartbeatAsync(
            "civ_a",
            new HeartbeatDto { Projection = projection, LastProcessedWorldCursor = "cursor-7" },
            CancellationToken.None);

        Assert.True(result.IsSuccess);
        Assert.Equal(1, result.Value.PendingCommandCount);
        Assert.Equal(15, result.Value.NextHeartbeatInSeconds);
        var stored = await world.Civilizations.GetAsync("civ_a", CancellationToken.None);
        Assert.Equal(12, stored!.Turn);
        Assert.Equal(345, stored.Population);
        Assert.Equal("cursor-7", stored.LastProcessedWorldCursor);
        Assert.Equal(world.Clock.GetUtcNow(), stored.LastHeartbeatAt);
    }

    [Fact]
    public async Task HeartbeatAsync_UnknownCivilization_ReturnsNotFound()
    {
        var world = new TestWorld();
        var projection = new PublicProjectionDto
        {
            CivId = "missing",
            DisplayName = "Missing",
            ProtocolVersion = "1.0",
            Turn = 0,
            Running = false,
            Population = 0,
            UpdatedAt = world.Clock.GetUtcNow(),
        };

        var result = await world.Civilization.HeartbeatAsync(
            "missing",
            new HeartbeatDto { Projection = projection },
            CancellationToken.None);

        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.CivilizationNotFound, result.Error.Code);
    }

    [Fact]
    public async Task HeartbeatAsync_NullProjection_ReturnsValidationFailed()
    {
        var world = new TestWorld();

        var result = await world.Civilization.HeartbeatAsync(
            "civ_a",
            new HeartbeatDto(),
            CancellationToken.None);

        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.ValidationFailed, result.Error.Code);
    }

    [Fact]
    public async Task ListAsync_PaginatesByOrdinal()
    {
        var world = new TestWorld();
        await world.SeedCivAsync("civ_a", 1);
        await world.SeedCivAsync("civ_b", 2);
        await world.SeedCivAsync("civ_c", 3);

        var first = await world.Civilization.ListAsync(null, 2, CancellationToken.None);
        var second = await world.Civilization.ListAsync(first.Value.NextCursor, 2, CancellationToken.None);

        Assert.True(first.IsSuccess);
        Assert.Equal(["civ_a", "civ_b"], first.Value.Items.Select(c => c.CivId));
        Assert.NotNull(first.Value.NextCursor);
        Assert.True(second.IsSuccess);
        Assert.Single(second.Value.Items);
        Assert.Equal("civ_c", second.Value.Items[0].CivId);
        Assert.Null(second.Value.NextCursor);
    }

    private static Command CreateCommand(string commandId, string target) => new()
    {
        CommandId = commandId,
        TargetCivId = target,
        CommandSequence = 1,
        EventId = "evt_1",
        Type = "test.command",
        Source = "/world",
        DeliveredAt = DateTimeOffset.UtcNow,
        CreatedAt = DateTimeOffset.UtcNow,
    };
}
