using WorldMap.Core.Common;
using WorldMap.Core.Domain;

namespace WorldMap.UnitTests.Services;

public sealed class RelationshipServiceTests
{
    [Fact]
    public async Task ListAsync_WithPair_ReturnsCanonicalOneItemPage()
    {
        var world = new TestWorld();
        var relationship = Relationship.CreateNeutral("civ_a", "civ_b", 1, world.Clock.GetUtcNow());
        await world.Relationships.UpsertAsync(relationship, CancellationToken.None);

        var result = await world.Relationship.ListAsync(
            null,
            null,
            "civ_b",
            "civ_a",
            CancellationToken.None);

        Assert.True(result.IsSuccess);
        var item = Assert.Single(result.Value.Items);
        Assert.Equal("civ_a", item.Pair.CivA);
        Assert.Equal("civ_b", item.Pair.CivB);
        Assert.Null(result.Value.NextCursor);
    }

    [Fact]
    public async Task ListAsync_WithUnknownPair_ReturnsRelationshipNotFound()
    {
        var world = new TestWorld();

        var result = await world.Relationship.ListAsync(
            null,
            null,
            "civ_a",
            "civ_b",
            CancellationToken.None);

        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.RelationshipNotFound, result.Error.Code);
    }

    [Fact]
    public async Task ListAsync_WithOnlyCivA_ReturnsValidationFailed()
    {
        var world = new TestWorld();

        var result = await world.Relationship.ListAsync(
            null,
            null,
            "civ_a",
            null,
            CancellationToken.None);

        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.ValidationFailed, result.Error.Code);
    }

    [Fact]
    public async Task ListAsync_PaginatesByOrdinal()
    {
        var world = new TestWorld();
        foreach (var relationship in new[]
        {
            Relationship.CreateNeutral("civ_a", "civ_b", 1, world.Clock.GetUtcNow()),
            Relationship.CreateNeutral("civ_a", "civ_c", 2, world.Clock.GetUtcNow()),
            Relationship.CreateNeutral("civ_a", "civ_d", 3, world.Clock.GetUtcNow()),
        })
        {
            await world.Relationships.UpsertAsync(relationship, CancellationToken.None);
        }

        var first = await world.Relationship.ListAsync(null, 2, null, null, CancellationToken.None);
        var second = await world.Relationship.ListAsync(
            first.Value.NextCursor,
            2,
            null,
            null,
            CancellationToken.None);

        Assert.Equal(2, first.Value.Items.Count);
        Assert.NotNull(first.Value.NextCursor);
        Assert.Single(second.Value.Items);
        Assert.Null(second.Value.NextCursor);
    }
}
