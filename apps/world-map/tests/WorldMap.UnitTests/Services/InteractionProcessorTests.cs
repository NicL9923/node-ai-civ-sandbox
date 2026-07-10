using WorldMap.Core.Abstractions;
using WorldMap.Core.Domain;
using WorldMap.UnitTests.Fakes;

namespace WorldMap.UnitTests.Services;

public sealed class InteractionProcessorTests
{
    [Fact]
    public async Task HappyPathCreatesExactlyOneSafeEventRelationshipAndCommand()
    {
        var world = new TestWorld();
        var id = await SeedAccepted(world);

        await world.Processor.ProcessAsync(id, default);
        await AssertCompletedExactlyOnce(world, id);
    }

    [Theory]
    [InlineData("event")]
    [InlineData("relationship")]
    [InlineData("command")]
    public async Task FailureAfterCommittedStep_ReplayConvergesWithoutDoubleEffects(string failurePoint)
    {
        var world = new TestWorld();
        var id = await SeedAccepted(world);
        IWorldEventRepository events = world.WorldEvents;
        IRelationshipRepository relationships = world.Relationships;
        ICommandRepository commands = world.Commands;

        switch (failurePoint)
        {
            case "event": events = new ThrowOnceAfterWorldEventAppend(events); break;
            case "relationship": relationships = new ThrowOnceAfterRelationshipUpsert(relationships); break;
            case "command": commands = new ThrowOnceAfterCommandEnqueue(commands); break;
        }

        var processor = world.CreateProcessor(events, relationships, commands);
        await Assert.ThrowsAsync<InjectedFailureException>(() => processor.ProcessAsync(id, default));

        await processor.ProcessAsync(id, default);
        await AssertCompletedExactlyOnce(world, id);
    }

    private static async Task<string> SeedAccepted(TestWorld world)
    {
        var (source, target) = await world.SeedCivPairAsync();
        var id = Ids.InteractionId("processor-test");
        var now = world.Clock.GetUtcNow();
        await world.InteractionRepository.AddAsync(new Interaction
        {
            InteractionId = id,
            Kind = "contact",
            Source = source,
            Target = target,
            AuthorityDecision = new() { Mode = "president" },
            PublicNarrative = "safe narrative",
            Payload = TestWorld.ContactRequest(source, target).Payload,
            CommandId = Interaction.DeriveCommandId(id),
            EventId = Interaction.DeriveEventId(id),
            CreatedAt = now,
            UpdatedAt = now,
            EffectiveExpiresAt = now.AddMinutes(1),
        }, default);
        return id;
    }

    private static async Task AssertCompletedExactlyOnce(TestWorld world, string id)
    {
        var interaction = await world.InteractionRepository.GetAsync(id, default);
        Assert.Equal(InteractionStatus.Queued, interaction!.Status);
        Assert.Equal(InteractionStep.Done, interaction.Step);
        Assert.NotNull(interaction.Worldsequence);
        Assert.Equal(Interaction.DeriveCommandId(id), interaction.CommandId);

        var commands = await world.Commands.PullAsync("civ_b", 0, 10, default);
        Assert.Equal(interaction.CommandId, Assert.Single(commands).CommandId);

        var events = await world.WorldEvents.ListAsync(0, 10, default);
        var worldEvent = Assert.Single(events.Items);
        Assert.NotNull(worldEvent.PublicData);
        Assert.DoesNotContain("Greetings", worldEvent.PublicData!.ToJsonString());

        var relationship = await world.Relationships.GetAsync(Relationship.PairKeyFor("civ_a", "civ_b"), default);
        Assert.Equal(0.10, relationship!.Familiarity, 10);
        Assert.True(relationship.HasApplied(interaction.Worldsequence!.Value));
    }
}
