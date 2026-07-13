using System.Threading.RateLimiting;

namespace WorldMap.Api.Middleware;

/// <summary>
/// Post-authentication, per-civilization rate limiter. Partitioned by the HMAC-VERIFIED civ id
/// (never a client-supplied header), so one civ cannot consume another civ's bucket by rotating
/// <c>X-Civ-Id</c>. The pre-auth global limiter (partitioned by network identity) is separate.
/// </summary>
public sealed class CivRateLimiter : IDisposable
{
    private readonly PartitionedRateLimiter<string> _limiter =
        PartitionedRateLimiter.Create<string, string>(civId =>
            RateLimitPartition.GetSlidingWindowLimiter(civId, _ => new SlidingWindowRateLimiterOptions
            {
                PermitLimit = 600,
                Window = TimeSpan.FromMinutes(1),
                SegmentsPerWindow = 6,
                QueueLimit = 0,
            }));

    /// <summary>Attempts to acquire a permit for a verified civ. Returns false when rate-limited.</summary>
    public async ValueTask<bool> TryAcquireAsync(string civId)
    {
        using var lease = await _limiter.AcquireAsync(civId, 1);
        return lease.IsAcquired;
    }

    public void Dispose() => _limiter.Dispose();
}
