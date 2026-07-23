using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Common;
using WorldMap.Core.Configuration;

namespace WorldMap.Core.Application;

/// <summary>
/// Orchestrates the contract-mandated ordering for a social mutation: peek the idempotency record →
/// (existing → replay/conflict via the executor, bypassing the rate limit) OR (new → apply the
/// per-account rate limit BEFORE claiming; a 429 never claims a key) → run the effect once through the
/// <see cref="IdempotencyExecutor"/>, consuming a rate permit only on a real execution. A successful
/// retry of an already-completed request always replays even when the account is now limited.
/// </summary>
public sealed class SocialMutationPipeline(
    IIdempotencyStore idempotencyStore,
    IdempotencyExecutor executor,
    SocialRateLimiter rateLimiter,
    IOptions<WorldMapOptions> options)
{
    private readonly TimeSpan _ttl = TimeSpan.FromSeconds(options.Value.Social.IdempotencyTtlSeconds);

    public async Task<Result<SocialMutationEnvelope<T>>> RunAsync<T>(
        string scope,
        string fingerprint,
        string accountId,
        SocialQuota quota,
        Func<CancellationToken, Task<Result<OperationOutcome<T>>>> effect,
        CancellationToken ct)
    {
        // A brand-new request (no prior record for this scope) is subject to the current rate-limit
        // policy BEFORE it may claim the idempotency key. An existing record (completed replay or a
        // concurrent pending owner) bypasses the rate limit so a successful retry always replays.
        var existing = await idempotencyStore.GetAsync(scope, ct);
        if (existing is null)
        {
            var decision = await rateLimiter.CheckAsync(accountId, quota, ct);
            if (!decision.Allowed)
            {
                return ErrorResult.Create(
                    ErrorCode.RateLimited,
                    "Per-account social rate limit exceeded. Retry after the required delay.",
                    retryable: true,
                    retryAfterSeconds: decision.RetryAfterSeconds);
            }
        }

        var outcome = await executor.ExecuteAsync(
            scope,
            fingerprint,
            _ttl,
            async innerCt =>
            {
                var result = await effect(innerCt);
                if (result.IsSuccess)
                {
                    // Consume a permit exactly once, as part of the single run of the effect. A replay
                    // short-circuits before here, so an idempotent retry never double-consumes.
                    await rateLimiter.RecordAsync(accountId, quota, innerCt);
                }

                return result;
            },
            body => body,
            ct);

        if (!outcome.IsSuccess)
        {
            return outcome.Error;
        }

        var headers = (await rateLimiter.CheckAsync(accountId, quota, ct)).Headers;
        return new SocialMutationEnvelope<T>(outcome.Value.Body, outcome.Value.StatusCode, outcome.Value.Location, headers);
    }
}
