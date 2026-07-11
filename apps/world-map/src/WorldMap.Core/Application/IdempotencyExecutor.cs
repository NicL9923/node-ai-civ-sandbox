using System.Text.Json;
using Microsoft.Extensions.Logging;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Common;
using WorldMap.Core.Contracts;
using WorldMap.Core.Domain;

namespace WorldMap.Core.Application;

/// <summary>The response an idempotent operation produces: the wire body, HTTP status, and Location.</summary>
public readonly record struct OperationOutcome<T>(T Body, int StatusCode, string? Location);

/// <summary>
/// Centralizes the atomic claim → run-once → complete idempotency pattern for every mutating
/// operation. A caller CLAIMS a scope before any effect; the winner runs the effect once and
/// COMPLETES the claim with the exact response; replays return the stored response; a different
/// request fingerprint for the same scope is a hard 409. Concurrent identical callers produce a
/// single effect — losers wait for completion and replay it (or, if the owner stalled/crashed, take
/// over, relying on the effect being idempotent).
/// </summary>
public sealed class IdempotencyExecutor(
    IIdempotencyStore store,
    TimeProvider clock,
    ILogger<IdempotencyExecutor> logger)
{
    private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(25);
    private const int MaxPolls = 120; // ~3s wait budget for a concurrent pending owner.

    public async Task<Result<OperationOutcome<T>>> ExecuteAsync<T>(
        string scope,
        string fingerprint,
        TimeSpan ttl,
        Func<CancellationToken, Task<Result<OperationOutcome<T>>>> effect,
        Func<T, T> markDuplicate,
        CancellationToken ct,
        Func<ErrorInfo>? onConflict = null)
    {
        var now = clock.GetUtcNow();
        var claim = await store.ClaimAsync(scope, fingerprint, now, now.Add(ttl), ct);

        switch (claim.Outcome)
        {
            case IdempotencyClaimOutcome.Won:
                return await RunAndCompleteAsync(scope, fingerprint, claim.Record.LeaseToken, effect, ct);

            case IdempotencyClaimOutcome.Completed:
                return Replay(claim.Record, markDuplicate);

            case IdempotencyClaimOutcome.FingerprintConflict:
                return Conflict(onConflict);

            case IdempotencyClaimOutcome.AlreadyPending:
                return await WaitOrReclaimAsync(scope, fingerprint, ttl, effect, markDuplicate, ct, onConflict);

            default:
                return ErrorResult.Create(ErrorCode.Internal, "Unexpected idempotency outcome.", retryable: true);
        }
    }

    private async Task<Result<OperationOutcome<T>>> RunAndCompleteAsync<T>(
        string scope,
        string fingerprint,
        string leaseToken,
        Func<CancellationToken, Task<Result<OperationOutcome<T>>>> effect,
        CancellationToken ct)
    {
        Result<OperationOutcome<T>> result;
        try
        {
            result = await effect(ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // A mid-effect crash: RELEASE the claim so a retry can re-run (effects are idempotent),
            // then surface the failure. Without this, the leased pending claim would block retries.
            await store.ReleaseAsync(scope, fingerprint, leaseToken, CancellationToken.None);
            throw;
        }

        if (!result.IsSuccess)
        {
            // The effect failed: RELEASE the claim so a retry can immediately re-run rather than
            // waiting out the pending lease. (We never store a failure as a completed response.)
            await store.ReleaseAsync(scope, fingerprint, leaseToken, ct);
            return result.Error;
        }

        var outcome = result.Value;
        var json = JsonSerializer.Serialize(outcome.Body, WorldMapJson.Options);
        await store.CompleteAsync(scope, fingerprint, leaseToken, json, outcome.StatusCode, outcome.Location, clock.GetUtcNow(), ct);
        return outcome;
    }

    private async Task<Result<OperationOutcome<T>>> WaitOrReclaimAsync<T>(
        string scope,
        string fingerprint,
        TimeSpan ttl,
        Func<CancellationToken, Task<Result<OperationOutcome<T>>>> effect,
        Func<T, T> markDuplicate,
        CancellationToken ct,
        Func<ErrorInfo>? onConflict)
    {
        // Poll by RE-CLAIMING (never a blind re-run): the store grants the pending scope to exactly
        // one caller, and only after the owner's lease elapses. So a live owner is never executed
        // concurrently, and a crashed owner is atomically taken over by a single winner.
        for (var i = 0; i < MaxPolls; i++)
        {
            await Task.Delay(PollInterval, clock, ct);
            var now = clock.GetUtcNow();
            var claim = await store.ClaimAsync(scope, fingerprint, now, now.Add(ttl), ct);
            switch (claim.Outcome)
            {
                case IdempotencyClaimOutcome.Won:
                    return await RunAndCompleteAsync(scope, fingerprint, claim.Record.LeaseToken, effect, ct);
                case IdempotencyClaimOutcome.Completed:
                    return Replay(claim.Record, markDuplicate);
                case IdempotencyClaimOutcome.FingerprintConflict:
                    return Conflict(onConflict);
                case IdempotencyClaimOutcome.AlreadyPending:
                    continue;
            }
        }

        // The owner is still running past our wait budget (slow, not yet crashed). Ask the caller to
        // retry rather than execute the effect concurrently.
        logger.LogWarning("Idempotency scope owned and pending past the wait budget; asking caller to retry.");
        return ErrorResult.Create(ErrorCode.OperationCancelled, "A matching request is still being processed; retry shortly.", retryable: true);
    }

    private static Result<OperationOutcome<T>> Replay<T>(IdempotencyRecord record, Func<T, T> markDuplicate)
    {
        if (record.ResponseJson is null)
        {
            return ErrorResult.Create(ErrorCode.Internal, "Completed idempotency record is missing its response.", retryable: true);
        }

        var body = JsonSerializer.Deserialize<T>(record.ResponseJson, WorldMapJson.Options)!;
        return new OperationOutcome<T>(markDuplicate(body), record.StatusCode, record.Location);
    }

    private static ErrorInfo Conflict(Func<ErrorInfo>? onConflict = null) =>
        onConflict?.Invoke()
        ?? ErrorResult.Create(ErrorCode.IdempotencyConflict, "This Idempotency-Key was already used with a different request.");
}
