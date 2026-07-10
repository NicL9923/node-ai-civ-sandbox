using System.Net;
using WorldMap.IntegrationTests.Harness;

namespace WorldMap.IntegrationTests.Tests;

/// <summary>
/// The pre-auth GLOBAL rate limiter partitions by NETWORK identity (client IP), never by the
/// client-supplied <c>X-Civ-Id</c> header, and health probes are exempt. These properties are
/// asserted structurally (not by fragile 429 timing): forging the header cannot mint a private
/// bucket, and <c>/health</c> is never throttled — so a flood cannot lock a legitimate civ out.
/// </summary>
public sealed class RateLimitIsolationTests : WorldTestBase
{
    // Comfortably above the 600/min global permit limit so the bucket is provably exhausted
    // within a single sliding-window burst.
    private const int OverGlobalLimit = 700;

    private static HttpRequestMessage Get(string url, string forgedCivId)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.TryAddWithoutValidation("X-Civ-Id", forgedCivId);
        return request;
    }

    [Fact]
    public async Task Health_is_never_rate_limited_even_under_a_forged_civ_id_flood()
    {
        // Far more than the per-IP permit limit, each with a distinct forged X-Civ-Id. If /health
        // were subject to the limiter (or partitioned by the header) some of these would 429.
        for (var i = 0; i < OverGlobalLimit; i++)
        {
            using var request = Get("/health", forgedCivId: $"civ_forged_{i}");
            using var response = await Client.SendAsync(request);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        }
    }

    [Fact]
    public async Task Pre_auth_limiter_partitions_by_ip_not_by_forged_civ_id_header()
    {
        // Flood a NON-exempt public path from one client, rotating X-Civ-Id every request. If the
        // limiter (incorrectly) partitioned by the header, each distinct value would get its own
        // full budget and never be throttled. Because it partitions by IP, all requests share one
        // bucket, so exceeding the limit deterministically yields at least one 429 — proving the
        // header cannot be used to mint a private, un-throttled bucket.
        var sawRateLimited = false;
        var sawSuccess = false;

        for (var i = 0; i < OverGlobalLimit; i++)
        {
            using var request = Get("/world/v1/civilizations", forgedCivId: $"civ_forged_{i}");
            using var response = await Client.SendAsync(request);

            if (response.StatusCode == HttpStatusCode.TooManyRequests)
            {
                sawRateLimited = true;
                var problem = await ProblemBody.ReadAsync(response);
                Assert.Equal("rate_limited", problem.Code);
                Assert.True(problem.Retryable);
                break;
            }

            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            sawSuccess = true;
        }

        Assert.True(sawSuccess, "the shared bucket should serve requests until the limit is reached.");
        Assert.True(
            sawRateLimited,
            "forged X-Civ-Id headers must share one IP-scoped bucket, so exceeding the limit must 429.");
    }

    [Fact]
    public async Task A_forged_header_flood_does_not_lock_a_legitimate_civ_out_of_health()
    {
        // Register a real civ, then flood the shared pre-auth bucket with forged-header public
        // reads until it throttles. The legitimate civ's liveness path (/health) must remain
        // available throughout — isolation means a noisy client cannot deny health probes.
        var civ = await Factory.RegisterCivAsync(Client, "Aurora");

        for (var i = 0; i < OverGlobalLimit; i++)
        {
            using var noise = Get("/world/v1/civilizations", forgedCivId: civ.CivId);
            using var _ = await Client.SendAsync(noise);
        }

        using var health = await Client.GetAsync("/health");
        Assert.Equal(HttpStatusCode.OK, health.StatusCode);
    }
}
