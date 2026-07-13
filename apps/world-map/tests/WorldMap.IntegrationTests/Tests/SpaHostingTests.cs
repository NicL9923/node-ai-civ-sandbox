using System.Net;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using WorldMap.IntegrationTests.Harness;

namespace WorldMap.IntegrationTests.Tests;

/// <summary>
/// Verifies the observer SPA static-hosting wiring: when <c>WorldMap:WebRoot</c> points at a
/// directory of built assets, the host serves the index and assets, falls back to index.html for
/// client-side deep-links, and still routes the federation API and health probes normally. Uses a
/// synthetic temp web root so the test is deterministic and needs no Node/web build.
/// </summary>
public sealed class SpaHostingTests : IAsyncLifetime
{
    private const string IndexMarker = "SPA_INDEX_MARKER";

    private string _webRoot = null!;
    private WebApplicationFactory<Program> _factory = null!;
    private HttpClient _client = null!;

    public Task InitializeAsync()
    {
        _webRoot = Path.Combine(Path.GetTempPath(), "worldmap-spa-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(_webRoot, "assets"));
        File.WriteAllText(
            Path.Combine(_webRoot, "index.html"),
            $"<!doctype html><html><body><div id=\"root\">{IndexMarker}</div></body></html>");
        File.WriteAllText(Path.Combine(_webRoot, "assets", "app.js"), "console.log('spa');");

        _factory = new WorldAppFactory().WithWebHostBuilder(builder =>
            // Program.cs reads WorldMapOptions from configuration before Build(), so the web root
            // must be set via UseSetting (host settings) rather than a deferred config source.
            builder.UseSetting("WorldMap:WebRoot", _webRoot));
        _client = _factory.CreateClient();
        return Task.CompletedTask;
    }

    public async Task DisposeAsync()
    {
        _client?.Dispose();
        if (_factory is not null)
        {
            await _factory.DisposeAsync();
        }
        try
        {
            if (Directory.Exists(_webRoot)) Directory.Delete(_webRoot, recursive: true);
        }
        catch
        {
            // Best-effort temp cleanup.
        }
        GC.SuppressFinalize(this);
    }

    [Fact]
    public async Task Root_serves_the_spa_index()
    {
        var response = await _client.GetAsync("/");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        Assert.Contains(IndexMarker, body);
    }

    [Fact]
    public async Task Static_assets_are_served()
    {
        var response = await _client.GetAsync("/assets/app.js");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        Assert.Contains("console.log('spa')", body);
    }

    [Fact]
    public async Task Unknown_client_route_falls_back_to_index()
    {
        var response = await GetHtml("/some/deep/link");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        Assert.Contains(IndexMarker, body);
    }

    [Fact]
    public async Task Api_routes_are_not_shadowed_by_the_spa()
    {
        var response = await _client.GetAsync("/world/v1/civilizations");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        Assert.DoesNotContain(IndexMarker, body);
        Assert.Contains("items", body);
    }

    [Fact]
    public async Task Unknown_api_route_returns_404_not_index()
    {
        var response = await GetHtml("/world/v1/does-not-exist");
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        Assert.DoesNotContain(IndexMarker, body);
    }

    [Fact]
    public async Task Health_is_not_shadowed_by_the_spa()
    {
        var response = await _client.GetAsync("/health");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        Assert.DoesNotContain(IndexMarker, body);
    }

    [Fact]
    public async Task Deep_link_without_html_accept_does_not_return_index()
    {
        // A JSON client (e.g. an API caller) hitting an unknown route must get a plain 404,
        // never the SPA shell.
        using var request = new HttpRequestMessage(HttpMethod.Get, "/some/deep/link");
        request.Headers.TryAddWithoutValidation("Accept", "application/json");
        var response = await _client.SendAsync(request);
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.DoesNotContain(IndexMarker, await response.Content.ReadAsStringAsync());
    }

    [Theory]
    [InlineData("POST")]
    [InlineData("PUT")]
    [InlineData("DELETE")]
    public async Task Non_get_to_unknown_route_does_not_return_index(string method)
    {
        using var request = new HttpRequestMessage(new HttpMethod(method), "/some/deep/link");
        request.Headers.TryAddWithoutValidation("Accept", "text/html");
        var response = await _client.SendAsync(request);
        Assert.NotEqual(HttpStatusCode.OK, response.StatusCode);
        Assert.DoesNotContain(IndexMarker, await response.Content.ReadAsStringAsync());
    }

    [Theory]
    [InlineData("/assets/missing-abc123.js")]
    [InlineData("/nope.js")]
    [InlineData("/styles/theme.css")]
    public async Task Missing_asset_returns_404_not_index(string path)
    {
        // File-like / asset paths must 404 when absent — not silently resolve to the SPA shell.
        var response = await GetHtml(path);
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.DoesNotContain(IndexMarker, await response.Content.ReadAsStringAsync());
    }

    private Task<HttpResponseMessage> GetHtml(string path)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, path);
        request.Headers.TryAddWithoutValidation("Accept", "text/html,application/xhtml+xml");
        return _client.SendAsync(request);
    }
}
