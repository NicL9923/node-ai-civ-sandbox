using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using WorldMap.Core.Contracts;
using WorldMap.IntegrationTests.Harness;

namespace WorldMap.IntegrationTests.Tests;

/// <summary>End-to-end interaction lifecycle, idempotency, mismatch rejection, and durability.</summary>
public sealed class InteractionFlowTests : WorldTestBase
{
    private async Task<HttpResponseMessage> PostSignedAsync(string path, object dto, CivContext civ, string idempotencyKey)
    {
        var body = Signing.SerializeBody(dto);
        var request = Signing.BuildSignedRequest(
            HttpMethod.Post, path, string.Empty, body, civ.CivId, civ.KeyId, civ.Secret, idempotencyKey: idempotencyKey);
        return await Client.SendAsync(request);
    }

    private async Task<HttpResponseMessage> GetSignedAsync(string path, CivContext civ, string rawQuery = "")
    {
        var request = Signing.BuildSignedRequest(
            HttpMethod.Get, path, rawQuery, body: [], civId: civ.CivId, keyId: civ.KeyId, secret: civ.Secret);
        return await Client.SendAsync(request);
    }

    [Fact]
    public async Task Full_contact_flow_from_submit_to_acknowledged()
    {
        var a = await Factory.RegisterCivAsync(Client, "Republic of Aurora");
        var b = await Factory.RegisterCivAsync(Client, "Borealis Federation");

        // 1) A submits a contact interaction targeting B.
        var interaction = TestDtos.ContactInteraction(a.CivId, b.CivId, "Greetings from Aurora.");
        var submit = await PostSignedAsync("/world/v1/interactions", interaction, a, Guid.NewGuid().ToString("N"));

        Assert.Equal(HttpStatusCode.Accepted, submit.StatusCode);
        Assert.NotNull(submit.Headers.Location);
        var accepted = await submit.Content.ReadFromJsonAsync<AcceptedDto>(WorldMapJson.Options);
        var interactionId = accepted!.ResourceId!;
        Assert.False(accepted.Duplicate);

        // 2) A reads the interaction: queued (not yet pulled) or delivered.
        var afterSubmit = await ReadInteractionAsync(interactionId, a);
        Assert.Contains(afterSubmit.Status, new[] { "queued", "delivered" });

        // 3) B pulls its commands and finds the contact command for this interaction.
        var command = await PullContactCommandAsync(b, interactionId);
        Assert.Equal("world.civilization.contact.v1", command.Type);
        Assert.Equal(interactionId, command.Data!["interactionId"]!.GetValue<string>());

        // 4) B acks the command as applied.
        var ackPath = $"/world/v1/civilizations/{b.CivId}/commands/{command.Commandid}/ack";
        var ack = await PostSignedAsync(ackPath, TestDtos.AppliedAck(), b, Guid.NewGuid().ToString("N"));
        Assert.Equal(HttpStatusCode.OK, ack.StatusCode);
        var ackResult = await ack.Content.ReadFromJsonAsync<CommandAckResultDto>(WorldMapJson.Options);
        Assert.Equal("applied", ackResult!.Status);

        // 5) A reads the interaction again: now acknowledged.
        var afterAck = await ReadInteractionAsync(interactionId, a);
        Assert.Equal("acknowledged", afterAck.Status);

        // 6) The relationship now exists with positive familiarity.
        var relResponse = await Client.GetAsync($"/world/v1/relationships?civA={a.CivId}&civB={b.CivId}");
        Assert.Equal(HttpStatusCode.OK, relResponse.StatusCode);
        var relPage = await relResponse.Content.ReadFromJsonAsync<RelationshipPageDto>(WorldMapJson.Options);
        Assert.Single(relPage!.Items);
        Assert.True(relPage.Items[0].Familiarity > 0);

        // 7) The interaction is visible in the public world-event feed as a SAFE summary: the
        //    interaction id is surfaced via causationid (not raw data), the source/subject are the
        //    two civs, and data carries only the allowlisted contact summary — never the raw payload.
        var events = await Client.GetFromJsonAsync<EventPageDto>("/world/v1/events", WorldMapJson.Options);
        var contactEvent = Assert.Single(events!.Items, e =>
            e.Type == "world.civilization.contact.v1" && e.Causationid == interactionId);

        Assert.Equal($"/civilizations/{a.CivId}", contactEvent.Source);
        Assert.Equal(b.CivId, contactEvent.Subject);
        Assert.NotNull(contactEvent.Data);
        Assert.Equal("contact", contactEvent.Data!["kind"]!.GetValue<string>());
        Assert.Equal(a.CivId, contactEvent.Data["fromCiv"]!.GetValue<string>());

        // The raw request payload (the greeting text) must NOT leak into the public feed.
        var publicJson = contactEvent.Data.ToJsonString();
        Assert.DoesNotContain("Greetings from Aurora", publicJson, StringComparison.Ordinal);
        Assert.Null(contactEvent.Data["greeting"]);
    }

    [Fact]
    public async Task Third_civ_cannot_read_an_interaction_it_is_not_party_to()
    {
        var a = await Factory.RegisterCivAsync(Client, "Aurora");
        var b = await Factory.RegisterCivAsync(Client, "Borealis");
        var c = await Factory.RegisterCivAsync(Client, "Cindra");

        var interaction = TestDtos.ContactInteraction(a.CivId, b.CivId, "Between A and B only.");
        var submit = await PostSignedAsync("/world/v1/interactions", interaction, a, Guid.NewGuid().ToString("N"));
        Assert.Equal(HttpStatusCode.Accepted, submit.StatusCode);
        var interactionId = (await submit.Content.ReadFromJsonAsync<AcceptedDto>(WorldMapJson.Options))!.ResourceId!;

        // C signs a perfectly valid GET but is neither source nor target -> 403 access_denied.
        var response = await GetSignedAsync($"/world/v1/interactions/{interactionId}", c);
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        var problem = await ProblemBody.ReadAsync(response);
        Assert.Equal("access_denied", problem.Code);

        // Sanity: the actual target B can read it.
        var byTarget = await GetSignedAsync($"/world/v1/interactions/{interactionId}", b);
        Assert.Equal(HttpStatusCode.OK, byTarget.StatusCode);
    }

    [Fact]
    public async Task Interaction_replay_with_same_key_is_duplicate_with_same_id()
    {
        var a = await Factory.RegisterCivAsync(Client, "Aurora");
        var b = await Factory.RegisterCivAsync(Client, "Borealis");

        var key = Guid.NewGuid().ToString("N");
        var interaction = TestDtos.ContactInteraction(a.CivId, b.CivId, "Hello.");

        var first = await PostSignedAsync("/world/v1/interactions", interaction, a, key);
        Assert.Equal(HttpStatusCode.Accepted, first.StatusCode);
        var firstBody = await first.Content.ReadFromJsonAsync<AcceptedDto>(WorldMapJson.Options);

        // A signed replay reuses a different nonce (fresh request) but the same Idempotency-Key.
        var replay = await PostSignedAsync("/world/v1/interactions", interaction, a, key);
        Assert.Equal(HttpStatusCode.Accepted, replay.StatusCode);
        var replayBody = await replay.Content.ReadFromJsonAsync<AcceptedDto>(WorldMapJson.Options);

        Assert.True(replayBody!.Duplicate);
        Assert.Equal(firstBody!.ResourceId, replayBody.ResourceId);
    }

    [Fact]
    public async Task Interaction_source_not_matching_authenticated_civ_is_rejected()
    {
        var a = await Factory.RegisterCivAsync(Client, "Aurora");
        var b = await Factory.RegisterCivAsync(Client, "Borealis");

        // A signs the request (X-Civ-Id = A) but declares source = B in the body.
        var mismatched = TestDtos.ContactInteraction(b.CivId, a.CivId, "Spoofed source.");
        var response = await PostSignedAsync("/world/v1/interactions", mismatched, a, Guid.NewGuid().ToString("N"));

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        var problem = await ProblemBody.ReadAsync(response);
        Assert.Equal("civ_id_mismatch", problem.Code);
    }

    [Fact]
    public async Task Command_is_durable_for_a_civ_that_never_heartbeats()
    {
        var a = await Factory.RegisterCivAsync(Client, "Aurora");
        // B registers but never heartbeats (offline).
        var b = await Factory.RegisterCivAsync(Client, "Borealis");

        var interaction = TestDtos.ContactInteraction(a.CivId, b.CivId, "Are you there?");
        var submit = await PostSignedAsync("/world/v1/interactions", interaction, a, Guid.NewGuid().ToString("N"));
        Assert.Equal(HttpStatusCode.Accepted, submit.StatusCode);
        var interactionId = (await submit.Content.ReadFromJsonAsync<AcceptedDto>(WorldMapJson.Options))!.ResourceId!;

        // Later, the offline civ comes online and pulls — the command persisted.
        var command = await PullContactCommandAsync(b, interactionId);
        Assert.Equal(interactionId, command.Data!["interactionId"]!.GetValue<string>());
    }

    private async Task<InteractionDto> ReadInteractionAsync(string interactionId, CivContext reader)
    {
        var response = await GetSignedAsync($"/world/v1/interactions/{interactionId}", reader);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<InteractionDto>(WorldMapJson.Options))!;
    }

    private async Task<CommandDto> PullContactCommandAsync(CivContext puller, string interactionId)
    {
        var response = await GetSignedAsync($"/world/v1/civilizations/{puller.CivId}/commands", puller);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var page = await response.Content.ReadFromJsonAsync<CommandPageDto>(WorldMapJson.Options);
        var command = page!.Items.SingleOrDefault(c =>
            c.Data is not null && c.Data["interactionId"]?.GetValue<string>() == interactionId);

        Assert.NotNull(command);
        return command!;
    }
}
