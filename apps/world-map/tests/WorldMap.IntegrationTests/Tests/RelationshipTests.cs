using System.Net;
using WorldMap.IntegrationTests.Harness;

namespace WorldMap.IntegrationTests.Tests;

/// <summary>The relationship pair filter requires civA and civB together.</summary>
public sealed class RelationshipTests : WorldTestBase
{
    [Fact]
    public async Task Relationships_with_only_civA_returns_400_validation_failed()
    {
        var response = await Client.GetAsync("/world/v1/relationships?civA=civ_only");

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var problem = await ProblemBody.ReadAsync(response);
        Assert.Equal("validation_failed", problem.Code);
    }
}
