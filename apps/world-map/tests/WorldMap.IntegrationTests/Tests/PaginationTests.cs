using System.Net.Http.Json;
using WorldMap.Core.Contracts;
using WorldMap.IntegrationTests.Harness;

namespace WorldMap.IntegrationTests.Tests;

/// <summary>Cursor pagination over the public civilization list visits every civ exactly once.</summary>
public sealed class PaginationTests : WorldTestBase
{
    [Fact]
    public async Task Paging_civilizations_with_limit_2_visits_all_without_duplicates()
    {
        const int total = 5;
        var expected = new HashSet<string>();
        for (var i = 0; i < total; i++)
        {
            var civ = await Factory.RegisterCivAsync(Client, $"Civ {i}");
            expected.Add(civ.CivId);
        }

        var seen = new List<string>();
        string? cursor = null;
        var pages = 0;

        do
        {
            var url = cursor is null
                ? "/world/v1/civilizations?limit=2"
                : $"/world/v1/civilizations?limit=2&after={Uri.EscapeDataString(cursor)}";

            var page = await Client.GetFromJsonAsync<CivilizationListPageDto>(url, WorldMapJson.Options);
            Assert.NotNull(page);
            Assert.True(page!.Items.Count <= 2, "page honored the limit of 2.");

            seen.AddRange(page.Items.Select(p => p.CivId));
            cursor = page.NextCursor;
            Assert.True(++pages <= total + 2, "pagination did not terminate.");
        }
        while (cursor is not null);

        Assert.Equal(total, seen.Count);
        Assert.Equal(total, seen.Distinct().Count());
        Assert.Equal(expected, seen.ToHashSet());
    }
}
