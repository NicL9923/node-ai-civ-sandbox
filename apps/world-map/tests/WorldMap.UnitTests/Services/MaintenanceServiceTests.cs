using WorldMap.Core.Domain;

namespace WorldMap.UnitTests.Services;

public sealed class MaintenanceServiceTests
{
    [Fact]
    public async Task SweepAsync_AfterExpiry_ExpiresCommandAndInteraction()
    {
        var world = new TestWorld();
        var expiresAt = world.Clock.GetUtcNow().AddMinutes(1);
        var interaction = new Interaction
        {
            InteractionId = "int_1",
            Kind = "contact",
            Source = "civ_a",
            Target = "civ_b",
            Status = InteractionStatus.Queued,
            ExpiresAt = expiresAt,
            CreatedAt = world.Clock.GetUtcNow(),
            UpdatedAt = world.Clock.GetUtcNow(),
        };
        var command = new Command
        {
            CommandId = "cmd_1",
            TargetCivId = "civ_b",
            CommandSequence = 1,
            EventId = "evt_1",
            Type = "test.command",
            Source = "/world",
            DeliveredAt = world.Clock.GetUtcNow(),
            ExpiresAt = expiresAt,
            InteractionId = interaction.InteractionId,
            CreatedAt = world.Clock.GetUtcNow(),
        };
        await world.InteractionRepository.AddAsync(interaction, CancellationToken.None);
        await world.Commands.AddAsync(command, CancellationToken.None);
        world.Clock.Advance(TimeSpan.FromMinutes(2));

        await world.Maintenance.SweepAsync(CancellationToken.None);

        var storedInteraction = await world.InteractionRepository.GetAsync("int_1", CancellationToken.None);
        var storedCommand = await world.Commands.GetAsync("civ_b", "cmd_1", CancellationToken.None);
        Assert.Equal(InteractionStatus.Expired, storedInteraction!.Status);
        Assert.True(storedCommand!.Expired);
    }
}
