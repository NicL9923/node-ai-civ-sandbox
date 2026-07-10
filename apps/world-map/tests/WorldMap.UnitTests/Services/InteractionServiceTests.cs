using System.Text.Json;
using WorldMap.Core.Common;
using WorldMap.Core.Contracts;
using WorldMap.Core.Domain;

namespace WorldMap.UnitTests.Services;

public sealed class InteractionServiceTests
{
    [Fact]
    public async Task SubmitAsync_ValidContact_CreatesAllFederationArtifacts()
    {
        var world = new TestWorld();
        var (source, target) = await world.SeedCivPairAsync();

        var result = await world.Interactions.SubmitAsync(
            source,
            TestWorld.ContactRequest(source, target),
            "interaction-1",
            CancellationToken.None);

        Assert.True(result.IsSuccess);
        Assert.False(result.Value.Body.Duplicate);
        Assert.Equal("accepted", result.Value.Body.Status);
        Assert.Equal(result.Value.Body.StatusUrl, result.Value.Location);

        var interaction = await world.InteractionRepository.GetAsync(
            result.Value.Body.ResourceId!,
            CancellationToken.None);
        Assert.NotNull(interaction);
        Assert.Equal(InteractionStatus.Queued, interaction.Status);
        Assert.True(interaction.Worldsequence > 0);
        Assert.NotNull(interaction.CommandId);

        var command = await world.Commands.GetAsync(target, interaction.CommandId!, CancellationToken.None);
        Assert.NotNull(command);
        Assert.Equal(interaction.Worldsequence, command.Worldsequence);

        var relationship = await world.Relationships.GetAsync(
            Relationship.PairKeyFor(source, target),
            CancellationToken.None);
        Assert.NotNull(relationship);
        Assert.Equal(0.10, relationship.Familiarity, 10);

        var events = await world.WorldEvents.ListAsync(0, 10, CancellationToken.None);
        var worldEvent = Assert.Single(events.Items);
        Assert.Equal(interaction.Worldsequence, worldEvent.Worldsequence);
    }

    [Fact]
    public async Task SubmitAsync_SameIdempotencyKey_ReturnsDuplicateOriginal()
    {
        var world = new TestWorld();
        var (source, target) = await world.SeedCivPairAsync();
        var request = TestWorld.ContactRequest(source, target);

        var first = await world.Interactions.SubmitAsync(source, request, "same-key", CancellationToken.None);
        var replay = await world.Interactions.SubmitAsync(source, request, "same-key", CancellationToken.None);

        Assert.True(first.IsSuccess);
        Assert.True(replay.IsSuccess);
        Assert.False(first.Value.Body.Duplicate);
        Assert.True(replay.Value.Body.Duplicate);
        Assert.Equal(first.Value.Body.ResourceId, replay.Value.Body.ResourceId);
        Assert.Equal(first.Value.Location, replay.Value.Location);
    }

    [Fact]
    public async Task SubmitAsync_SourceDoesNotMatchAuthenticatedCiv_ReturnsCivIdMismatch()
    {
        var world = new TestWorld();
        await world.SeedCivPairAsync();

        var result = await world.Interactions.SubmitAsync(
            "civ_other",
            TestWorld.ContactRequest("civ_a", "civ_b"),
            "mismatch",
            CancellationToken.None);

        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.CivIdMismatch, result.Error.Code);
    }

    [Fact]
    public async Task SubmitAsync_UnknownTarget_ReturnsCivilizationNotFound()
    {
        var world = new TestWorld();
        await world.SeedCivAsync("civ_a", 1);

        var result = await world.Interactions.SubmitAsync(
            "civ_a",
            TestWorld.ContactRequest("civ_a", "missing"),
            "missing-target",
            CancellationToken.None);

        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.CivilizationNotFound, result.Error.Code);
    }

    [Theory]
    [InlineData("contact")]
    [InlineData("message")]
    public async Task SubmitAsync_MissingKindSpecificContent_ReturnsValidationFailed(string kind)
    {
        var world = new TestWorld();
        var (source, target) = await world.SeedCivPairAsync();
        var request = kind == "contact"
            ? TestWorld.ContactRequest(source, target, greeting: null)
            : TestWorld.MessageRequest(source, target, body: null);

        var result = await world.Interactions.SubmitAsync(
            source,
            request,
            $"missing-{kind}",
            CancellationToken.None);

        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.ValidationFailed, result.Error.Code);
    }

    [Fact]
    public async Task SubmitAsync_ValidMessage_UpdatesRelationshipNarrative()
    {
        var world = new TestWorld();
        var (source, target) = await world.SeedCivPairAsync();

        var result = await world.Interactions.SubmitAsync(
            source,
            TestWorld.MessageRequest(source, target),
            "message-1",
            CancellationToken.None);

        Assert.True(result.IsSuccess);
        var relationship = await world.Relationships.GetAsync(
            Relationship.PairKeyFor(source, target),
            CancellationToken.None);
        Assert.Equal(0.02, relationship!.Familiarity, 10);
        Assert.Equal("Aurora sent a public message: \"Trade\".", relationship.NarrativeSummary);
    }
}
