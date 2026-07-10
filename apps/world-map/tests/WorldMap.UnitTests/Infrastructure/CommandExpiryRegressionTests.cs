using Microsoft.Extensions.Time.Testing;
using WorldMap.Core.Domain;
using WorldMap.Infrastructure.InMemory;

namespace WorldMap.UnitTests.Infrastructure;

/// <summary>
/// Regression tests for defects an independent review surfaced: a command must stop being pullable at
/// its actual <c>ExpiresAt</c> — not only once the maintenance worker sets the <c>Expired</c> flag.
/// </summary>
public sealed class CommandExpiryRegressionTests
{
    [Fact]
    public async Task Pull_ExcludesCommandsPastExpiresAt_BeforeSweepFlag()
    {
        var clock = new FakeTimeProvider(new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero));
        var repo = new InMemoryCommandRepository(clock);

        await repo.EnqueueAsync(NewCommand("live", clock.GetUtcNow().AddMinutes(10)), default);
        await repo.EnqueueAsync(NewCommand("expiring", clock.GetUtcNow().AddSeconds(30)), default);

        // Both pullable before expiry.
        Assert.Equal(2, (await repo.PullAsync("civ_b", 0, 10, default)).Count);
        Assert.Equal(2, await repo.CountPendingAsync("civ_b", default));

        // Advance past one command's expiry — WITHOUT running any maintenance sweep.
        clock.Advance(TimeSpan.FromMinutes(1));

        var pulled = await repo.PullAsync("civ_b", 0, 10, default);
        Assert.Equal("live", Assert.Single(pulled).CommandId);
        Assert.Equal(1, await repo.CountPendingAsync("civ_b", default));
    }

    private static Command NewCommand(string id, DateTimeOffset expiresAt) => new()
    {
        CommandId = id,
        TargetCivId = "civ_b",
        EventId = $"evt-{id}",
        Type = "world.civilization.contact.v1",
        Source = "/civilizations/civ_a",
        DeliveredAt = DateTimeOffset.UnixEpoch,
        ExpiresAt = expiresAt,
        CreatedAt = DateTimeOffset.UnixEpoch,
    };
}
