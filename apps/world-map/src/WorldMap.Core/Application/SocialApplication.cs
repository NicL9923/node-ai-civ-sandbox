namespace WorldMap.Core.Application;

/// <summary>The three per-account social quota classes advertised via <c>SocialRateLimitPolicy</c>.</summary>
public enum SocialQuota
{
    Post,
    Reaction,
    Follow,
}

/// <summary>Rate-limit response headers for a social mutation (RateLimit-Limit/Remaining/Reset).</summary>
public sealed record SocialRateHeaders(int Limit, int Remaining, long ResetEpochSeconds);

/// <summary>Outcome of a per-account rate-limit evaluation.</summary>
public sealed record SocialRateDecision(bool Allowed, int RetryAfterSeconds, SocialRateHeaders Headers);

/// <summary>
/// A social mutation's response: the wire body, HTTP status, optional Location, and the rate-limit
/// headers to attach. Produced by <see cref="SocialMutationPipeline"/> and consumed by the endpoint.
/// </summary>
public sealed record SocialMutationEnvelope<T>(T Body, int StatusCode, string? Location, SocialRateHeaders? RateHeaders);
