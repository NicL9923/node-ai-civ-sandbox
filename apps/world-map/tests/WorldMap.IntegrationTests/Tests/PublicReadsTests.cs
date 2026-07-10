using System.Net;
using System.Net.Http.Json;
using WorldMap.Core.Contracts;
using WorldMap.IntegrationTests.Harness;

namespace WorldMap.IntegrationTests.Tests;

/// <summary>Public read endpoints and health must be reachable without any request signing.</summary>
public sealed class PublicReadsTests : WorldTestBase
{
    [Theory]
    [InlineData("/world/v1/civilizations")]
    [InlineData("/world/v1/relationships")]
    [InlineData("/world/v1/events")]
    public async Task Public_read_endpoints_return_200_without_signing(string url)
    {
        var response = await Client.GetAsync(url);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task Civilizations_list_returns_an_empty_page_initially()
    {
        var page = await Client.GetFromJsonAsync<CivilizationListPageDto>("/world/v1/civilizations", WorldMapJson.Options);

        Assert.NotNull(page);
        Assert.Empty(page!.Items);
        Assert.Null(page.NextCursor);
    }

    [Fact]
    public async Task Health_returns_200()
    {
        var response = await Client.GetAsync("/health");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }
}
