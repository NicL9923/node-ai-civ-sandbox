using WorldMap.Core.Common;
using WorldMap.Core.Domain;

namespace WorldMap.UnitTests.Services;

public sealed class RelationshipServiceTests
{
    [Fact]
    public async Task PairLookupCanonicalizesOrder()
    {
        var world = new TestWorld();
        var relationship = Relationship.CreateNeutral("civ_b", "civ_a", world.Clock.GetUtcNow());
        relationship.Version = 1;
        Assert.True(await world.Relationships.TryUpsertAsync(relationship, default));

        var result = await world.Relationship.ListAsync(null, null, "civ_b", "civ_a", default);

        Assert.True(result.IsSuccess);
        var item = Assert.Single(result.Value.Items);
        Assert.Equal("civ_a", item.Pair.CivA);
        Assert.Equal("civ_b", item.Pair.CivB);
    }

    [Theory]
    [InlineData("civ_a", null)]
    [InlineData(null, "civ_b")]
    public async Task PairLookupRequiresBothCivilizations(string? civA, string? civB)
    {
        var result = await new TestWorld().Relationship.ListAsync(null, null, civA, civB, default);

        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.ValidationFailed, result.Error.Code);
    }

    [Fact]
    public async Task PairLookupReturnsNotFound()
    {
        var result = await new TestWorld().Relationship.ListAsync(null, null, "a", "b", default);
        Assert.Equal(ErrorCode.RelationshipNotFound, result.Error.Code);
    }
}
