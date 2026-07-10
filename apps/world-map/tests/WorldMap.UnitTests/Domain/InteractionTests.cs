using System.Text.Json.Nodes;
using WorldMap.Core.Domain;

namespace WorldMap.UnitTests.Domain;

public sealed class InteractionTests
{
    private static readonly DateTimeOffset Start = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);

    [Fact]
    public void StateMachine_HappyPath_AdvancesThroughAcknowledged()
    {
        var interaction = CreateInteraction();

        interaction.Authorize(Start.AddMinutes(1));
        Assert.Equal(InteractionStatus.Authorized, interaction.Status);

        interaction.AssignSequence(42, Start.AddMinutes(2));
        Assert.Equal(42, interaction.Worldsequence);

        interaction.Queue("cmd_1", Start.AddMinutes(3));
        Assert.Equal(InteractionStatus.Queued, interaction.Status);
        Assert.Equal("cmd_1", interaction.CommandId);

        interaction.MarkDelivered(Start.AddMinutes(4));
        Assert.Equal(InteractionStatus.Delivered, interaction.Status);

        interaction.Acknowledge(Start.AddMinutes(5));
        Assert.Equal(InteractionStatus.Acknowledged, interaction.Status);
        Assert.True(interaction.IsTerminal);
        Assert.Equal(Start.AddMinutes(5), interaction.UpdatedAt);
    }

    [Theory]
    [InlineData(InteractionStatus.Received)]
    [InlineData(InteractionStatus.Authorized)]
    [InlineData(InteractionStatus.Delivered)]
    [InlineData(InteractionStatus.Acknowledged)]
    [InlineData(InteractionStatus.Rejected)]
    [InlineData(InteractionStatus.Expired)]
    [InlineData(InteractionStatus.Failed)]
    public void MarkDelivered_WhenNotQueued_IsNoOp(InteractionStatus status)
    {
        var interaction = CreateInteraction(status);
        var updatedAt = interaction.UpdatedAt;

        interaction.MarkDelivered(Start.AddHours(1));

        Assert.Equal(status, interaction.Status);
        Assert.Equal(updatedAt, interaction.UpdatedAt);
    }

    [Fact]
    public void Reject_SetsStatusAndProblem()
    {
        var interaction = CreateInteraction();
        var problem = JsonNode.Parse("""{"code":"declined"}""");

        interaction.Reject(problem, Start.AddMinutes(1));

        Assert.Equal(InteractionStatus.Rejected, interaction.Status);
        Assert.Equal("declined", interaction.Problem!["code"]!.GetValue<string>());
        Assert.True(interaction.IsTerminal);
    }

    [Fact]
    public void Expire_SetsExpiredTerminalStatus()
    {
        var interaction = CreateInteraction();

        interaction.Expire(Start.AddMinutes(1));

        Assert.Equal(InteractionStatus.Expired, interaction.Status);
        Assert.True(interaction.IsTerminal);
    }

    [Theory]
    [InlineData(InteractionStatus.Acknowledged, true)]
    [InlineData(InteractionStatus.Rejected, true)]
    [InlineData(InteractionStatus.Expired, true)]
    [InlineData(InteractionStatus.Failed, true)]
    [InlineData(InteractionStatus.Received, false)]
    [InlineData(InteractionStatus.Authorized, false)]
    [InlineData(InteractionStatus.Queued, false)]
    [InlineData(InteractionStatus.Delivered, false)]
    public void IsTerminal_MatchesLifecycleDefinition(InteractionStatus status, bool expected)
    {
        Assert.Equal(expected, CreateInteraction(status).IsTerminal);
    }

    [Fact]
    public void ToDto_MapsWorldSequenceAndWireStatus()
    {
        var interaction = CreateInteraction(InteractionStatus.Queued);
        interaction.Worldsequence = 987654321;

        var dto = interaction.ToDto();

        Assert.Equal("987654321", dto.Worldsequence);
        Assert.Equal("queued", dto.Status);
    }

    private static Interaction CreateInteraction(InteractionStatus status = InteractionStatus.Received) => new()
    {
        InteractionId = "int_1",
        Kind = "contact",
        Source = "civ_a",
        Target = "civ_b",
        Status = status,
        CreatedAt = Start,
        UpdatedAt = Start,
    };
}
