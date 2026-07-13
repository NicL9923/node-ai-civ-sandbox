using System.Net;
using System.Net.Http.Json;
using WorldMap.Core.Common;
using WorldMap.Core.Contracts;
using WorldMap.IntegrationTests.Harness;

namespace WorldMap.IntegrationTests.Tests;

/// <summary>
/// A signed GET whose query needs canonicalization (out-of-order keys, a percent-encoded
/// space) still verifies, proving the client and server canonicalize the query identically.
/// </summary>
public sealed class SignedQueryTests : WorldTestBase
{
    [Fact]
    public async Task Signed_commands_pull_with_messy_query_verifies()
    {
        var civ = await Factory.RegisterCivAsync(Client, "Aurora");
        var path = $"/world/v1/civilizations/{civ.CivId}/commands";

        // Keys out of order + a percent-encoded space exercise the query canonicalizer on
        // both sides. The exact wire query is what we sign, so both canonicalize the same.
        var cursor = CursorCodec.Encode(0);
        var rawQuery = $"limit=50&note=hello%20world&after={cursor}";

        using var request = Signing.BuildSignedRequest(
            HttpMethod.Get, path, rawQuery, body: [], civId: civ.CivId, keyId: civ.KeyId, secret: civ.Secret);

        var response = await Client.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var page = await response.Content.ReadFromJsonAsync<CommandPageDto>(WorldMapJson.Options);
        Assert.NotNull(page);
        Assert.Empty(page!.Items);
    }
}
