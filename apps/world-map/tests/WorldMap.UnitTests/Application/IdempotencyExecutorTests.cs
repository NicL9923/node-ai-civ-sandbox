using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using WorldMap.Core.Application;
using WorldMap.Core.Common;
using WorldMap.Core.Domain;
using WorldMap.Infrastructure.InMemory;

namespace WorldMap.UnitTests.Application;

public sealed class IdempotencyExecutorTests
{
    [Fact]
    public async Task WinnerCompletesAndReplayReturnsStoredDuplicateWithoutRerunning()
    {
        var clock = new FakeTimeProvider();
        var store = new InMemoryIdempotencyStore(clock);
        var executor = Create(store, clock);
        var invocations = 0;

        Task<Result<OperationOutcome<Payload>>> Effect(CancellationToken _) =>
            Task.FromResult<Result<OperationOutcome<Payload>>>(
                new OperationOutcome<Payload>(new Payload("original", false), 201, "/resource"));

        var first = await executor.ExecuteAsync("scope", "fp", TimeSpan.FromMinutes(1),
            ct => { Interlocked.Increment(ref invocations); return Effect(ct); },
            body => body with { Duplicate = true }, CancellationToken.None);
        var replay = await executor.ExecuteAsync("scope", "fp", TimeSpan.FromMinutes(1),
            ct => { Interlocked.Increment(ref invocations); return Effect(ct); },
            body => body with { Duplicate = true }, CancellationToken.None);

        Assert.True(first.IsSuccess);
        Assert.True(replay.IsSuccess);
        Assert.False(first.Value.Body.Duplicate);
        Assert.True(replay.Value.Body.Duplicate);
        Assert.Equal("/resource", replay.Value.Location);
        Assert.Equal(1, invocations);
        var record = await store.GetAsync("scope", CancellationToken.None);
        Assert.Equal(201, record!.StatusCode);
        Assert.Contains("original", record.ResponseJson);
    }

    [Fact]
    public async Task DifferentFingerprint_ReturnsConflict()
    {
        var clock = new FakeTimeProvider();
        var executor = Create(new InMemoryIdempotencyStore(clock), clock);
        await executor.ExecuteAsync("scope", "fp-a", TimeSpan.FromMinutes(1), Success, p => p, CancellationToken.None);

        var conflict = await executor.ExecuteAsync("scope", "fp-b", TimeSpan.FromMinutes(1), Success, p => p, CancellationToken.None);

        Assert.False(conflict.IsSuccess);
        Assert.Equal(ErrorCode.IdempotencyConflict, conflict.Error.Code);
    }

    [Fact]
    public async Task FailedEffectReleasesClaimSoRetryRunsAgain()
    {
        var clock = new FakeTimeProvider();
        var store = new InMemoryIdempotencyStore(clock);
        var executor = Create(store, clock);
        var invocations = 0;

        var failed = await executor.ExecuteAsync<Payload>(
            "scope", "fp", TimeSpan.FromSeconds(1),
            _ =>
            {
                Interlocked.Increment(ref invocations);
                return Task.FromResult<Result<OperationOutcome<Payload>>>(
                    ErrorResult.Create(ErrorCode.Internal, "injected"));
            },
            p => p,
            CancellationToken.None);

        Assert.False(failed.IsSuccess);
        // A failed effect releases the claim (never leaves a pending record blocking retries).
        Assert.Null(await store.GetAsync("scope", CancellationToken.None));

        var retry = await executor.ExecuteAsync(
            "scope", "fp", TimeSpan.FromSeconds(1),
            ct => { Interlocked.Increment(ref invocations); return Success(ct); },
            p => p,
            CancellationToken.None);

        Assert.True(retry.IsSuccess);
        Assert.Equal(2, invocations);
    }

    [Fact]
    public async Task ConcurrentIdenticalCalls_RunExactlyOneEffect()
    {
        var store = new InMemoryIdempotencyStore(TimeProvider.System);
        var executor = Create(store, TimeProvider.System);
        var invocations = 0;

        async Task<Result<OperationOutcome<Payload>>> Effect(CancellationToken ct)
        {
            Interlocked.Increment(ref invocations);
            await Task.Delay(75, ct);
            return new OperationOutcome<Payload>(new Payload("ok", false), 200, null);
        }

        var results = await Task.WhenAll(Enumerable.Range(0, 32).Select(_ =>
            executor.ExecuteAsync("shared", "fp", TimeSpan.FromMinutes(1), Effect,
                p => p with { Duplicate = true }, CancellationToken.None)));

        Assert.All(results, result => Assert.True(result.IsSuccess));
        Assert.Equal(1, invocations);
        Assert.Equal(1, results.Count(r => !r.Value.Body.Duplicate));
    }

    private static IdempotencyExecutor Create(InMemoryIdempotencyStore store, TimeProvider clock) =>
        new(store, clock, NullLogger<IdempotencyExecutor>.Instance);

    private static Task<Result<OperationOutcome<Payload>>> Success(CancellationToken _) =>
        Task.FromResult<Result<OperationOutcome<Payload>>>(
            new OperationOutcome<Payload>(new Payload("ok", false), 200, null));

    private sealed record Payload(string Value, bool Duplicate);
}
