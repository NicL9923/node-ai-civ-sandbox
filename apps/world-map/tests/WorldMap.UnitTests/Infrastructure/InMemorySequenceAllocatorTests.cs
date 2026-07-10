using WorldMap.Infrastructure.InMemory;

namespace WorldMap.UnitTests.Infrastructure;

public sealed class InMemorySequenceAllocatorTests
{
    [Fact]
    public async Task NextWorldSequenceAsync_ConcurrentCallsAreDistinctAndPositive()
    {
        var allocator = new InMemorySequenceAllocator();
        var tasks = Enumerable.Range(0, 1000)
            .Select(async _ => await allocator.NextWorldSequenceAsync(CancellationToken.None))
            .ToArray();

        var values = await Task.WhenAll(tasks);

        Assert.Equal(1000, values.Distinct().Count());
        Assert.All(values, value => Assert.True(value > 0));
        Assert.Equal(Enumerable.Range(1, 1000).Select(i => (long)i), values.Order());
    }

    [Fact]
    public async Task NextCommandSequenceAsync_IsStrictlyIncreasingAndIsolatedPerCiv()
    {
        var allocator = new InMemorySequenceAllocator();

        var a1 = await allocator.NextCommandSequenceAsync("civ_a", CancellationToken.None);
        var a2 = await allocator.NextCommandSequenceAsync("civ_a", CancellationToken.None);
        var b1 = await allocator.NextCommandSequenceAsync("civ_b", CancellationToken.None);
        var b2 = await allocator.NextCommandSequenceAsync("civ_b", CancellationToken.None);

        Assert.Equal(1, a1);
        Assert.Equal(2, a2);
        Assert.Equal(1, b1);
        Assert.Equal(2, b2);
    }
}
