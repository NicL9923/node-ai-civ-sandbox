using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using WorldMap.Core.Contracts;
using WorldMap.IntegrationTests.Harness;

namespace WorldMap.IntegrationTests.Tests;

/// <summary>Civilization onboarding: idempotency, token consumption, and no-secret-leakage.</summary>
public sealed class RegistrationTests : WorldTestBase
{
    private async Task<HttpResponseMessage> RegisterAsync(string token, string? idempotencyKey, string displayName = "Republic of Aurora")
    {
        var request = new HttpRequestMessage(HttpMethod.Post, "/world/v1/civilizations/register")
        {
            Content = JsonContent.Create(TestDtos.Registration(token, displayName), options: WorldMapJson.Options),
        };
        if (idempotencyKey is not null)
        {
            request.Headers.TryAddWithoutValidation("Idempotency-Key", idempotencyKey);
        }

        return await Client.SendAsync(request);
    }

    [Fact]
    public async Task Register_with_token_and_idempotency_key_returns_201_with_location_and_no_secret()
    {
        var response = await RegisterAsync(WorldAppFactory.PrimaryOnboardingToken, Guid.NewGuid().ToString("N"));

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        Assert.NotNull(response.Headers.Location);

        var text = await response.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(text);
        var root = doc.RootElement;

        Assert.Equal(JsonValueKind.String, root.GetProperty("civId").ValueKind);
        Assert.Equal(JsonValueKind.String, root.GetProperty("keyId").ValueKind);
        Assert.False(root.GetProperty("duplicate").GetBoolean());

        // The token binds to its fixed, preprovisioned civId.
        Assert.Equal(WorldAppFactory.PrimaryCivId, root.GetProperty("civId").GetString());

        // The secret is never returned — retrieval is strictly out-of-band.
        Assert.False(root.TryGetProperty("secret", out _));
        Assert.DoesNotContain("secret", text, StringComparison.OrdinalIgnoreCase);

        // Location points at the civ's public projection under the deterministic base URL.
        var civId = root.GetProperty("civId").GetString();
        Assert.Equal($"{WorldAppFactory.WorldBaseUrl}/civilizations/{civId}", response.Headers.Location!.ToString());
    }

    [Fact]
    public async Task Register_without_idempotency_key_returns_400()
    {
        var response = await RegisterAsync(WorldAppFactory.PrimaryOnboardingToken, idempotencyKey: null);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var problem = await ProblemBody.ReadAsync(response);
        Assert.Equal("validation_failed", problem.Code);
    }

    [Fact]
    public async Task Register_replay_with_same_key_returns_201_duplicate_true()
    {
        var key = Guid.NewGuid().ToString("N");

        var first = await RegisterAsync(WorldAppFactory.PrimaryOnboardingToken, key);
        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        var firstBody = await first.Content.ReadFromJsonAsync<RegistrationResponseDto>(WorldMapJson.Options);

        var replay = await RegisterAsync(WorldAppFactory.PrimaryOnboardingToken, key);
        Assert.Equal(HttpStatusCode.Created, replay.StatusCode);
        var replayBody = await replay.Content.ReadFromJsonAsync<RegistrationResponseDto>(WorldMapJson.Options);

        Assert.True(replayBody!.Duplicate);
        Assert.Equal(firstBody!.CivId, replayBody.CivId);
        Assert.Equal(firstBody.KeyId, replayBody.KeyId);
    }

    [Fact]
    public async Task Register_same_key_with_different_body_returns_409_idempotency_conflict()
    {
        var key = Guid.NewGuid().ToString("N");

        var first = await RegisterAsync(WorldAppFactory.PrimaryOnboardingToken, key, displayName: "Republic of Aurora");
        Assert.Equal(HttpStatusCode.Created, first.StatusCode);

        // Same token + same Idempotency-Key but a DIFFERENT request body: the stored fingerprint
        // no longer matches, so this is a hard idempotency conflict, not a replay.
        var conflict = await RegisterAsync(WorldAppFactory.PrimaryOnboardingToken, key, displayName: "Totally Different Name");

        Assert.Equal(HttpStatusCode.Conflict, conflict.StatusCode);
        var problem = await ProblemBody.ReadAsync(conflict);
        Assert.Equal("idempotency_conflict", problem.Code);
    }

    [Fact]
    public async Task Register_with_bad_token_returns_409_registration_conflict()
    {
        var response = await RegisterAsync("not-a-configured-token", Guid.NewGuid().ToString("N"));

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var problem = await ProblemBody.ReadAsync(response);
        Assert.Equal("registration_conflict", problem.Code);
    }

    [Fact]
    public async Task Get_civilization_projection_leaks_no_key_or_secret()
    {
        var civ = await Factory.RegisterCivAsync(Client, "Republic of Aurora");

        var response = await Client.GetAsync($"/world/v1/civilizations/{civ.CivId}");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var text = await response.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(text);
        var root = doc.RootElement;

        Assert.Equal(civ.CivId, root.GetProperty("civId").GetString());
        Assert.False(root.TryGetProperty("keyId", out _));
        Assert.DoesNotContain("secret", text, StringComparison.OrdinalIgnoreCase);
    }
}
