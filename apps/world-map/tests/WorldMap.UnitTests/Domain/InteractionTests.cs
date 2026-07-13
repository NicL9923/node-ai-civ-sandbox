using WorldMap.Core.Domain;

namespace WorldMap.UnitTests.Domain;

public sealed class InteractionTests
{
    private static readonly DateTimeOffset Now = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);

    [Fact]
    public void StateMachine_AdvancesAcceptedThroughDone()
    {
        var interaction = Create();

        interaction.MarkAuthorized(Now);
        Assert.Equal(InteractionStatus.Authorized, interaction.Status);
        Assert.Equal(InteractionStep.Authorized, interaction.Step);

        interaction.AdvanceStep(InteractionStep.EventAppended, Now.AddSeconds(1));
        interaction.AdvanceStep(InteractionStep.RelationshipUpdated, Now.AddSeconds(2));
        interaction.AdvanceStep(InteractionStep.CommandQueued, Now.AddSeconds(3));
        interaction.MarkQueued(Now.AddSeconds(4));

        Assert.Equal(InteractionStatus.Queued, interaction.Status);
        Assert.Equal(InteractionStep.Done, interaction.Step);
        Assert.True(interaction.IsProcessingComplete);
        Assert.False(interaction.IsTerminal);
        Assert.Equal(5, interaction.Version);
    }

    [Fact]
    public void MarkDelivered_OnlyTransitionsFromQueued()
    {
        var interaction = Create();

        interaction.MarkDelivered(Now);
        Assert.Equal(InteractionStatus.Received, interaction.Status);
        Assert.Equal(0, interaction.Version);

        interaction.MarkAuthorized(Now);
        interaction.MarkQueued(Now);
        interaction.MarkDelivered(Now);
        Assert.Equal(InteractionStatus.Delivered, interaction.Status);
    }

    [Theory]
    [InlineData(InteractionStatus.Acknowledged)]
    [InlineData(InteractionStatus.Rejected)]
    [InlineData(InteractionStatus.Expired)]
    public void TerminalStatus_CannotBeOverwritten(InteractionStatus terminal)
    {
        var interaction = Create();
        switch (terminal)
        {
            case InteractionStatus.Acknowledged: interaction.Acknowledge(Now); break;
            case InteractionStatus.Rejected: interaction.Reject(null, Now); break;
            case InteractionStatus.Expired: interaction.Expire(Now); break;
        }

        var version = interaction.Version;
        interaction.Acknowledge(Now.AddMinutes(1));
        interaction.Reject(null, Now.AddMinutes(1));
        interaction.Expire(Now.AddMinutes(1));
        interaction.MarkQueued(Now.AddMinutes(1));

        Assert.Equal(terminal, interaction.Status);
        Assert.True(interaction.IsTerminal);
        Assert.True(interaction.IsProcessingComplete);
        Assert.Equal(version + 1, interaction.Version);
    }

    [Fact]
    public void ToDto_MapsEffectiveExpiryAndWorldSequenceAsString()
    {
        var interaction = Create();
        interaction.Worldsequence = 9007199254740991;
        interaction.EffectiveExpiresAt = Now.AddHours(1);

        var dto = interaction.ToDto();

        Assert.Equal("9007199254740991", dto.Worldsequence);
        Assert.Equal(interaction.EffectiveExpiresAt, dto.ExpiresAt);
    }

    [Fact]
    public void DeterministicIds_AreStableAndScoped()
    {
        var first = Ids.InteractionId("scope-a");
        Assert.Equal(first, Ids.InteractionId("scope-a"));
        Assert.NotEqual(first, Ids.InteractionId("scope-b"));
        Assert.Equal(Ids.CorrelationId(first), Ids.CorrelationId(first));
        Assert.Equal(Interaction.DeriveCommandId(first), Interaction.DeriveCommandId(first));
        Assert.Equal(Interaction.DeriveEventId(first), Interaction.DeriveEventId(first));
        Assert.StartsWith("int_", first);
    }

    internal static Interaction Create(string id = "int_test") => new()
    {
        InteractionId = id,
        Kind = "contact",
        Source = "civ_a",
        Target = "civ_b",
        CommandId = Interaction.DeriveCommandId(id),
        EventId = Interaction.DeriveEventId(id),
        CreatedAt = Now,
        UpdatedAt = Now,
    };
}
