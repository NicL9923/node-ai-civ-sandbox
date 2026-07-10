using System.Net;
using System.Net.Http.Headers;
using WorldMap.IntegrationTests.Harness;

namespace WorldMap.IntegrationTests.Tests;

/// <summary>
/// Every HMAC failure mode returns an <c>application/problem+json</c> 401/403 with the stable
/// machine-readable <c>code</c>. Registration + signing here reuse the production signer.
/// </summary>
public sealed class HmacAuthFailureTests : WorldTestBase
{
    private static HttpContent JsonBody(byte[] body)
    {
        var content = new ByteArrayContent(body);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        return content;
    }

    [Fact]
    public async Task Missing_signing_headers_returns_401()
    {
        var civ = await Factory.RegisterCivAsync(Client, "Aurora");
        var path = $"/world/v1/civilizations/{civ.CivId}/heartbeat";
        var body = Signing.SerializeBody(TestDtos.Heartbeat(civ.CivId, "Aurora"));

        using var request = new HttpRequestMessage(HttpMethod.Post, path) { Content = JsonBody(body) };
        var response = await Client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        var problem = await ProblemBody.ReadAsync(response);
        Assert.Equal("unauthorized", problem.Code);
        Assert.False(problem.Retryable);
    }

    [Fact]
    public async Task Tampered_body_returns_401_invalid_signature()
    {
        var civ = await Factory.RegisterCivAsync(Client, "Aurora");
        var path = $"/world/v1/civilizations/{civ.CivId}/heartbeat";

        var signedBody = Signing.SerializeBody(TestDtos.Heartbeat(civ.CivId, "Aurora", turn: 1));
        var sentBody = Signing.SerializeBody(TestDtos.Heartbeat(civ.CivId, "Aurora", turn: 999));

        var headers = Signing.BuildHeaders("POST", path, string.Empty, signedBody, civ.CivId, civ.KeyId, civ.Secret);
        using var request = Signing.Assemble(HttpMethod.Post, path, string.Empty, sentBody, headers, sendBody: true);

        var response = await Client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        var problem = await ProblemBody.ReadAsync(response);
        Assert.Equal("invalid_signature", problem.Code);
    }

    [Fact]
    public async Task Wrong_secret_returns_401_invalid_signature()
    {
        var civ = await Factory.RegisterCivAsync(Client, "Aurora");
        var path = $"/world/v1/civilizations/{civ.CivId}/heartbeat";
        var body = Signing.SerializeBody(TestDtos.Heartbeat(civ.CivId, "Aurora"));

        using var request = Signing.BuildSignedRequest(
            HttpMethod.Post, path, string.Empty, body, civ.CivId, civ.KeyId, secret: "totally-wrong-secret");

        var response = await Client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        var problem = await ProblemBody.ReadAsync(response);
        Assert.Equal("invalid_signature", problem.Code);
    }

    [Fact]
    public async Task Timestamp_skew_beyond_window_returns_401_clock_skew()
    {
        var civ = await Factory.RegisterCivAsync(Client, "Aurora");
        var path = $"/world/v1/civilizations/{civ.CivId}/heartbeat";
        var body = Signing.SerializeBody(TestDtos.Heartbeat(civ.CivId, "Aurora"));

        var skewed = DateTimeOffset.UtcNow.ToUnixTimeSeconds() - 400; // > 300s window
        using var request = Signing.BuildSignedRequest(
            HttpMethod.Post, path, string.Empty, body, civ.CivId, civ.KeyId, civ.Secret, timestamp: skewed);

        var response = await Client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        var problem = await ProblemBody.ReadAsync(response);
        Assert.Equal("clock_skew", problem.Code);
    }

    [Fact]
    public async Task Nonce_reuse_returns_401_replay_detected()
    {
        var civ = await Factory.RegisterCivAsync(Client, "Aurora");
        var path = $"/world/v1/civilizations/{civ.CivId}/heartbeat";
        var body = Signing.SerializeBody(TestDtos.Heartbeat(civ.CivId, "Aurora"));

        var nonce = Guid.NewGuid().ToString("N");
        var timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var headers = Signing.BuildHeaders(
            "POST", path, string.Empty, body, civ.CivId, civ.KeyId, civ.Secret, nonce: nonce, timestamp: timestamp);

        using var first = Signing.Assemble(HttpMethod.Post, path, string.Empty, body, headers, sendBody: true);
        var firstResponse = await Client.SendAsync(first);
        Assert.Equal(HttpStatusCode.OK, firstResponse.StatusCode);

        using var replay = Signing.Assemble(HttpMethod.Post, path, string.Empty, body, headers, sendBody: true);
        var replayResponse = await Client.SendAsync(replay);

        Assert.Equal(HttpStatusCode.Unauthorized, replayResponse.StatusCode);
        var problem = await ProblemBody.ReadAsync(replayResponse);
        Assert.Equal("replay_detected", problem.Code);
    }

    [Fact]
    public async Task Civ_id_header_mismatch_with_route_returns_403_civ_id_mismatch()
    {
        var a = await Factory.RegisterCivAsync(Client, "Aurora");
        var b = await Factory.RegisterCivAsync(Client, "Borealis");

        // Route targets A's heartbeat, but we sign and present B's identity.
        var path = $"/world/v1/civilizations/{a.CivId}/heartbeat";
        var body = Signing.SerializeBody(TestDtos.Heartbeat(b.CivId, "Borealis"));

        using var request = Signing.BuildSignedRequest(
            HttpMethod.Post, path, string.Empty, body, b.CivId, b.KeyId, b.Secret);

        var response = await Client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        var problem = await ProblemBody.ReadAsync(response);
        Assert.Equal("civ_id_mismatch", problem.Code);
    }

    [Fact]
    public async Task Two_civs_sharing_key_id_may_reuse_the_same_nonce_without_false_replay()
    {
        // Both civs are provisioned with keyId "key_01"; the nonce store is scoped by
        // civId+keyId+nonce, so an identical nonce value from two DIFFERENT civs is NOT a replay.
        var a = await Factory.RegisterCivAsync(Client, "Aurora");
        var b = await Factory.RegisterCivAsync(Client, "Borealis");
        Assert.Equal(a.KeyId, b.KeyId);

        var sharedNonce = Guid.NewGuid().ToString("N");
        var timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds();

        var responseA = await SignedHeartbeatAsync(a, sharedNonce, timestamp);
        Assert.Equal(HttpStatusCode.OK, responseA.StatusCode);

        var responseB = await SignedHeartbeatAsync(b, sharedNonce, timestamp);
        Assert.Equal(HttpStatusCode.OK, responseB.StatusCode);
    }

    private async Task<HttpResponseMessage> SignedHeartbeatAsync(CivContext civ, string nonce, long timestamp)
    {
        var path = $"/world/v1/civilizations/{civ.CivId}/heartbeat";
        var body = Signing.SerializeBody(TestDtos.Heartbeat(civ.CivId, civ.CivId));
        var request = Signing.BuildSignedRequest(
            HttpMethod.Post, path, string.Empty, body, civ.CivId, civ.KeyId, civ.Secret,
            nonce: nonce, timestamp: timestamp);
        return await Client.SendAsync(request);
    }
}
