using System.Net;
using System.Net.Http.Json;
using WorldMap.Core.Contracts;
using WorldMap.IntegrationTests.Harness;

namespace WorldMap.IntegrationTests.Tests;

/// <summary>A signed heartbeat refreshes liveness and returns a HeartbeatAck.</summary>
public sealed class HeartbeatTests : WorldTestBase
{
    [Fact]
    public async Task Signed_heartbeat_returns_200_ack()
    {
        var civ = await Factory.RegisterCivAsync(Client, "Republic of Aurora");

        var path = $"/world/v1/civilizations/{civ.CivId}/heartbeat";
        var body = Signing.SerializeBody(TestDtos.Heartbeat(civ.CivId, "Republic of Aurora", turn: 42));

        using var request = Signing.BuildSignedRequest(
            HttpMethod.Post, path, rawQuery: string.Empty, body: body,
            civId: civ.CivId, keyId: civ.KeyId, secret: civ.Secret);

        var response = await Client.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var ack = await response.Content.ReadFromJsonAsync<HeartbeatAckDto>(WorldMapJson.Options);
        Assert.NotNull(ack);
        Assert.Equal(civ.CivId, ack!.CivId);
        Assert.True(ack.ServerTime > DateTimeOffset.UnixEpoch);
        Assert.Equal(0, ack.PendingCommandCount);
    }
}
