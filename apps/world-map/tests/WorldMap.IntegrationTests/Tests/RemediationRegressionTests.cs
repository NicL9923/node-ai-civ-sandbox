using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using WorldMap.Core.Contracts;
using WorldMap.IntegrationTests.Harness;

namespace WorldMap.IntegrationTests.Tests;

/// <summary>End-to-end regressions for security and persistence remediation.</summary>
public sealed class RemediationRegressionTests : WorldTestBase
{
    protected override WorldAppFactory CreateFactory() => new(useControllableTime: true);

    [Fact]
    public Task Minimum_timestamp_returns_401_instead_of_500() =>
        AssertExtremeTimestampAsync(long.MinValue);

    [Fact]
    public Task Maximum_timestamp_returns_401_instead_of_500() =>
        AssertExtremeTimestampAsync(long.MaxValue);

    [Fact]
    public async Task Registration_replay_is_token_anchored_across_different_idempotency_keys()
    {
        var first = await RegisterAsync(
            WorldAppFactory.PrimaryOnboardingToken,
            $"registration-first-{Guid.NewGuid():N}",
            "Republic of Aurora");
        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        var firstBody = await first.Content.ReadFromJsonAsync<RegistrationResponseDto>(WorldMapJson.Options);
        Assert.NotNull(firstBody);
        Assert.False(firstBody.Duplicate);

        var replay = await RegisterAsync(
            WorldAppFactory.PrimaryOnboardingToken,
            $"registration-replay-{Guid.NewGuid():N}",
            "Republic of Aurora");
        Assert.Equal(HttpStatusCode.Created, replay.StatusCode);
        var replayBody = await replay.Content.ReadFromJsonAsync<RegistrationResponseDto>(WorldMapJson.Options);
        Assert.NotNull(replayBody);
        Assert.True(replayBody.Duplicate);
        Assert.Equal(firstBody.CivId, replayBody.CivId);
    }

    [Fact]
    public async Task Acking_an_expired_command_returns_404_command_not_found()
    {
        var source = await Factory.RegisterCivAsync(Client, "Aurora");
        var target = await Factory.RegisterCivAsync(Client, "Borealis");

        var interaction = TestDtos.ContactInteraction(source.CivId, target.CivId, "Greetings from Aurora.");
        var submit = await PostSignedAsync(
            "/world/v1/interactions",
            interaction,
            source,
            $"interaction-{Guid.NewGuid():N}");
        Assert.Equal(HttpStatusCode.Accepted, submit.StatusCode);
        var accepted = await submit.Content.ReadFromJsonAsync<AcceptedDto>(WorldMapJson.Options);
        Assert.NotNull(accepted);

        var pull = await GetSignedAsync($"/world/v1/civilizations/{target.CivId}/commands", target);
        Assert.Equal(HttpStatusCode.OK, pull.StatusCode);
        var page = await pull.Content.ReadFromJsonAsync<CommandPageDto>(WorldMapJson.Options);
        var command = Assert.Single(page!.Items, item =>
            item.Data?["interactionId"]?.GetValue<string>() == accepted.ResourceId);

        await Factory.AdvanceTimeAndSweepAsync(TimeSpan.FromDays(8));

        var ackPath = $"/world/v1/civilizations/{target.CivId}/commands/{command.Commandid}/ack";
        var ack = await PostSignedAsync(
            ackPath,
            TestDtos.AppliedAck(),
            target,
            $"ack-{Guid.NewGuid():N}",
            Factory.UtcNow.ToUnixTimeSeconds());

        Assert.Equal(HttpStatusCode.NotFound, ack.StatusCode);
        var problem = await ProblemBody.ReadAsync(ack);
        Assert.Equal("command_not_found", problem.Code);
    }

    [Fact]
    public async Task Oversized_event_data_is_rejected_before_persistence()
    {
        var civ = await Factory.RegisterCivAsync(Client, "Aurora");
        var eventId = $"oversized-data-{Guid.NewGuid():N}";
        var data = new JsonObject { ["value"] = new string('x', 70_000) };
        var evt = TestDtos.CivEvent(civ.CivId, eventId, $"event-{Guid.NewGuid():N}", data);

        var response = await PostBatchAsync(civ, TestDtos.Batch(evt));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var problem = await ProblemBody.ReadAsync(response);
        Assert.Equal("payload_too_large", problem.Code);
        Assert.DoesNotContain(eventId, await WorldEventIdsAsync());
    }

    [Fact]
    public async Task Event_with_overlong_subject_is_rejected_400_payload_too_large()
    {
        var civ = await Factory.RegisterCivAsync(Client, "Aurora");
        var eventId = $"overlong-subject-{Guid.NewGuid():N}";
        var evt = TestDtos.CivEvent(civ.CivId, eventId, $"event-{Guid.NewGuid():N}") with
        {
            Subject = new string('x', 4096),
        };

        var response = await PostBatchAsync(civ, TestDtos.Batch(evt));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var problem = await ProblemBody.ReadAsync(response);
        Assert.Equal("payload_too_large", problem.Code);
        Assert.DoesNotContain(eventId, await WorldEventIdsAsync());
    }

    private async Task AssertExtremeTimestampAsync(long timestamp)
    {
        var civ = await Factory.RegisterCivAsync(Client, "Aurora");
        var path = $"/world/v1/civilizations/{civ.CivId}/heartbeat";
        var body = Signing.SerializeBody(TestDtos.Heartbeat(civ.CivId, "Aurora"));
        using var request = Signing.BuildSignedRequest(
            HttpMethod.Post,
            path,
            string.Empty,
            body,
            civ.CivId,
            civ.KeyId,
            civ.Secret,
            timestamp: timestamp,
            nonce: $"extreme-{Guid.NewGuid():N}");

        var response = await Client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        var problem = await ProblemBody.ReadAsync(response);
        Assert.Equal("clock_skew", problem.Code);
    }

    private async Task<HttpResponseMessage> RegisterAsync(string token, string idempotencyKey, string displayName)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, "/world/v1/civilizations/register")
        {
            Content = JsonContent.Create(TestDtos.Registration(token, displayName), options: WorldMapJson.Options),
        };
        request.Headers.TryAddWithoutValidation("Idempotency-Key", idempotencyKey);
        return await Client.SendAsync(request);
    }

    private async Task<HttpResponseMessage> PostSignedAsync(
        string path,
        object dto,
        CivContext civ,
        string idempotencyKey,
        long? timestamp = null)
    {
        var body = Signing.SerializeBody(dto);
        var request = Signing.BuildSignedRequest(
            HttpMethod.Post,
            path,
            string.Empty,
            body,
            civ.CivId,
            civ.KeyId,
            civ.Secret,
            idempotencyKey,
            timestamp);
        return await Client.SendAsync(request);
    }

    private async Task<HttpResponseMessage> GetSignedAsync(string path, CivContext civ)
    {
        var request = Signing.BuildSignedRequest(
            HttpMethod.Get,
            path,
            string.Empty,
            body: [],
            civId: civ.CivId,
            keyId: civ.KeyId,
            secret: civ.Secret);
        return await Client.SendAsync(request);
    }

    private async Task<HttpResponseMessage> PostBatchAsync(CivContext civ, EventBatchDto batch)
    {
        var path = $"/world/v1/civilizations/{civ.CivId}/events/batch";
        var body = Signing.SerializeBody(batch);
        var request = Signing.BuildSignedRequest(
            HttpMethod.Post,
            path,
            string.Empty,
            body,
            civ.CivId,
            civ.KeyId,
            civ.Secret,
            idempotencyKey: $"batch-{Guid.NewGuid():N}");
        return await Client.SendAsync(request);
    }

    private async Task<HashSet<string>> WorldEventIdsAsync()
    {
        var page = await Client.GetFromJsonAsync<EventPageDto>("/world/v1/events", WorldMapJson.Options);
        return page!.Items.Select(evt => evt.Id).ToHashSet(StringComparer.Ordinal);
    }
}
