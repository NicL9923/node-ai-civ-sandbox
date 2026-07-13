using WorldMap.Core.Common;
using WorldMap.Core.Domain;

namespace WorldMap.UnitTests.Services;

public sealed class InteractionServiceTests
{
    [Fact]
    public async Task SourceAndTargetCanReadButThirdCivilizationCannot()
    {
        var world = new TestWorld();
        var (source, target) = await world.SeedCivPairAsync();
        var submitted = await world.Interactions.SubmitAsync(
            source, TestWorld.ContactRequest(source, target), "key", default);
        var id = submitted.Value.Body.ResourceId!;

        Assert.True((await world.Interactions.GetAsync(source, id, default)).IsSuccess);
        Assert.True((await world.Interactions.GetAsync(target, id, default)).IsSuccess);
        var denied = await world.Interactions.GetAsync("civ_third", id, default);
        Assert.False(denied.IsSuccess);
        Assert.Equal(ErrorCode.AccessDenied, denied.Error.Code);
    }

    [Fact]
    public async Task SameSubmissionKeyReplaysDeterministicInteraction()
    {
        var world = new TestWorld();
        var (source, target) = await world.SeedCivPairAsync();
        var request = TestWorld.ContactRequest(source, target);

        var first = await world.Interactions.SubmitAsync(source, request, "key", default);
        var replay = await world.Interactions.SubmitAsync(source, request, "key", default);

        Assert.False(first.Value.Body.Duplicate);
        Assert.True(replay.Value.Body.Duplicate);
        Assert.Equal(first.Value.Body.ResourceId, replay.Value.Body.ResourceId);
        Assert.Equal(InteractionStatus.Queued,
            (await world.InteractionRepository.GetAsync(first.Value.Body.ResourceId!, default))!.Status);
    }

    [Theory]
    [InlineData("civ_other", "civ_a", "civ_b", ErrorCode.CivIdMismatch)]
    [InlineData("civ_a", "civ_a", "missing", ErrorCode.CivilizationNotFound)]
    public async Task SubmissionAuthorizationAndTargetAreValidated(
        string authenticated, string source, string target, ErrorCode expected)
    {
        var world = new TestWorld();
        await world.SeedCivPairAsync();

        var result = await world.Interactions.SubmitAsync(
            authenticated, TestWorld.ContactRequest(source, target), "key", default);

        Assert.False(result.IsSuccess);
        Assert.Equal(expected, result.Error.Code);
    }
}
