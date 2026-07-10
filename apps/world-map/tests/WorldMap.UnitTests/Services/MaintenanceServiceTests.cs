using WorldMap.Core.Domain;
using WorldMap.UnitTests.Domain;

namespace WorldMap.UnitTests.Services;

public sealed class MaintenanceServiceTests
{
    [Fact]
    public async Task SweepResumesIncompleteInteractions()
    {
        var world = new TestWorld();
        var (source, target) = await world.SeedCivPairAsync();
        var interaction = InteractionTests.Create();
        interaction.Source = source;
        interaction.Target = target;
        await world.InteractionRepository.AddAsync(interaction, default);

        await world.Maintenance.SweepAsync(default);

        Assert.Equal(InteractionStatus.Queued,
            (await world.InteractionRepository.GetAsync(interaction.InteractionId, default))!.Status);
        Assert.Single(await world.Commands.PullAsync(target, 0, 10, default));
    }

    [Fact]
    public async Task SweepExpiresCommandAndLinkedInteractionPastEffectiveExpiry()
    {
        var world = new TestWorld();
        var now = world.Clock.GetUtcNow();
        var interaction = CreateQueued("int-expire", now.AddSeconds(1));
        await world.InteractionRepository.AddAsync(interaction, default);
        await world.Commands.EnqueueAsync(new Command
        {
            CommandId = interaction.CommandId,
            TargetCivId = interaction.Target,
            EventId = interaction.EventId,
            Type = "test",
            Source = "/world",
            DeliveredAt = now,
            ExpiresAt = interaction.EffectiveExpiresAt,
            InteractionId = interaction.InteractionId,
            CreatedAt = now,
        }, default);

        world.Clock.Advance(TimeSpan.FromSeconds(2));
        await world.Maintenance.SweepAsync(default);

        Assert.Equal(InteractionStatus.Expired,
            (await world.InteractionRepository.GetAsync(interaction.InteractionId, default))!.Status);
        var command = await world.Commands.GetAsync(interaction.Target, interaction.CommandId, default);
        Assert.True(command!.Expired);
        Assert.False(command.IsPullable);
    }

    [Fact]
    public async Task SweepExpiresInteractionWithoutCommandPastEffectiveExpiry()
    {
        var world = new TestWorld();
        var interaction = CreateQueued("int-alone", world.Clock.GetUtcNow().AddSeconds(1));
        await world.InteractionRepository.AddAsync(interaction, default);
        world.Clock.Advance(TimeSpan.FromSeconds(2));

        await world.Maintenance.SweepAsync(default);

        Assert.Equal(InteractionStatus.Expired,
            (await world.InteractionRepository.GetAsync(interaction.InteractionId, default))!.Status);
    }

    private static Interaction CreateQueued(string id, DateTimeOffset expiresAt) => new()
    {
        InteractionId = id,
        Kind = "contact",
        Source = "civ_a",
        Target = "civ_b",
        Status = InteractionStatus.Queued,
        Step = InteractionStep.Done,
        CommandId = Interaction.DeriveCommandId(id),
        EventId = Interaction.DeriveEventId(id),
        CreatedAt = expiresAt.AddMinutes(-1),
        UpdatedAt = expiresAt.AddMinutes(-1),
        EffectiveExpiresAt = expiresAt,
    };
}
