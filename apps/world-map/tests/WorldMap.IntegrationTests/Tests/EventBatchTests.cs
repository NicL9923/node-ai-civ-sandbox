using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using WorldMap.Core.Contracts;
using WorldMap.IntegrationTests.Harness;

namespace WorldMap.IntegrationTests.Tests;

/// <summary>Event batch ingestion: sequencing, per-event dedupe, and batch-level idempotency.</summary>
public sealed class EventBatchTests : WorldTestBase
{
    private async Task<EventBatchResultDto> IngestAsync(CivContext civ, EventBatchDto batch, string idempotencyKey)
    {
        var path = $"/world/v1/civilizations/{civ.CivId}/events/batch";
        var body = Signing.SerializeBody(batch);
        using var request = Signing.BuildSignedRequest(
            HttpMethod.Post, path, string.Empty, body, civ.CivId, civ.KeyId, civ.Secret, idempotencyKey: idempotencyKey);

        var response = await Client.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<EventBatchResultDto>(WorldMapJson.Options))!;
    }

    private async Task<HttpResponseMessage> PostBatchAsync(CivContext civ, EventBatchDto batch, string idempotencyKey)
    {
        var path = $"/world/v1/civilizations/{civ.CivId}/events/batch";
        var body = Signing.SerializeBody(batch);
        var request = Signing.BuildSignedRequest(
            HttpMethod.Post, path, string.Empty, body, civ.CivId, civ.KeyId, civ.Secret, idempotencyKey: idempotencyKey);
        return await Client.SendAsync(request);
    }

    private async Task<HashSet<string>> WorldEventIdsAsync()
    {
        var page = await Client.GetFromJsonAsync<EventPageDto>("/world/v1/events", WorldMapJson.Options);
        return page!.Items.Select(e => e.Id).ToHashSet(StringComparer.Ordinal);
    }

    [Fact]
    public async Task Batch_ingest_dedupe_and_replay()
    {
        var civ = await Factory.RegisterCivAsync(Client, "Aurora");
        var batchKey = Guid.NewGuid().ToString("N");

        var batch = TestDtos.EventBatch(civ.CivId, ("aurora-evt-1", "ce-1"), ("aurora-evt-2", "ce-2"));
        var first = await IngestAsync(civ, batch, batchKey);

        Assert.Equal(2, first.AcceptedCount);
        Assert.Equal(0, first.DuplicateCount);
        Assert.All(first.Results, r => Assert.Equal("accepted", r.Status));

        var ws1 = long.Parse(first.Results[0].Worldsequence!);
        var ws2 = long.Parse(first.Results[1].Worldsequence!);
        Assert.True(ws2 > ws1, "worldsequence must strictly increase across accepted events.");

        // Resend one event (same CloudEvents idempotencykey) under a NEW batch key -> duplicate.
        var resend = TestDtos.EventBatch(civ.CivId, ("aurora-evt-1", "ce-1"));
        var second = await IngestAsync(civ, resend, Guid.NewGuid().ToString("N"));

        Assert.Equal(1, second.DuplicateCount);
        Assert.Equal("duplicate", second.Results[0].Status);
        Assert.Equal(ws1, long.Parse(second.Results[0].Worldsequence!));

        // Batch-level idempotency: replaying the original batch key returns the identical result.
        var replay = await IngestAsync(civ, batch, batchKey);
        Assert.Equal(first.AcceptedCount, replay.AcceptedCount);
        Assert.Equal(first.DuplicateCount, replay.DuplicateCount);
        Assert.Equal(first.Results[0].Worldsequence, replay.Results[0].Worldsequence);
        Assert.Equal(first.Results[1].Worldsequence, replay.Results[1].Worldsequence);
    }

    [Fact]
    public async Task Event_with_source_of_another_civ_is_rejected_400()
    {
        var a = await Factory.RegisterCivAsync(Client, "Aurora");
        var b = await Factory.RegisterCivAsync(Client, "Borealis");

        // Signed and routed as A, but the event's source claims to be B -> cannot publish as another civ.
        var spoofed = TestDtos.EventBatch(b.CivId, ("spoof-evt-1", "spoof-1"));
        var response = await PostBatchAsync(a, spoofed, Guid.NewGuid().ToString("N"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var problem = await ProblemBody.ReadAsync(response);
        Assert.Equal("validation_failed", problem.Code);

        // Nothing was persisted from the rejected batch.
        Assert.DoesNotContain("spoof-evt-1", await WorldEventIdsAsync());
    }

    [Fact]
    public async Task Batch_with_an_invalid_item_is_rejected_400_with_zero_persistence()
    {
        var civ = await Factory.RegisterCivAsync(Client, "Aurora");

        // The batch mixes one valid event with one invalid event (bad specversion). Full-batch
        // validation must reject the whole batch atomically with zero persistence.
        var valid = TestDtos.CivEvent(civ.CivId, "valid-evt-1", "v-1");
        var invalid = TestDtos.CivEvent(civ.CivId, "invalid-evt-1", "i-1") with { Specversion = "9.9" };
        var mixed = TestDtos.Batch(valid, invalid);

        var response = await PostBatchAsync(civ, mixed, Guid.NewGuid().ToString("N"));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var problem = await ProblemBody.ReadAsync(response);
        Assert.Equal("validation_failed", problem.Code);

        // Neither the valid nor the invalid item was persisted.
        var afterReject = await WorldEventIdsAsync();
        Assert.DoesNotContain("valid-evt-1", afterReject);
        Assert.DoesNotContain("invalid-evt-1", afterReject);

        // A subsequent clean batch starts fresh and succeeds.
        var clean = TestDtos.EventBatch(civ.CivId, ("valid-evt-1", "v-1"));
        var accepted = await IngestAsync(civ, clean, Guid.NewGuid().ToString("N"));
        Assert.Equal(1, accepted.AcceptedCount);
        Assert.Contains("valid-evt-1", await WorldEventIdsAsync());
    }

    [Fact]
    public async Task Ingested_event_data_is_never_surfaced_in_the_public_feed()
    {
        var civ = await Factory.RegisterCivAsync(Client, "Aurora");

        // The producer supplies rich, arbitrary data. The public feed must surface only the
        // envelope (data == null) — the raw producer payload is never reflected publicly.
        var secretData = new JsonObject { ["classified"] = "top-secret-agent-plan", ["target"] = "civ_x" };
        var evt = TestDtos.CivEvent(civ.CivId, "privacy-evt-1", "p-1", secretData);
        var result = await IngestAsync(civ, TestDtos.Batch(evt), Guid.NewGuid().ToString("N"));
        Assert.Equal(1, result.AcceptedCount);

        var pageText = await Client.GetStringAsync("/world/v1/events");
        Assert.DoesNotContain("top-secret-agent-plan", pageText, StringComparison.Ordinal);

        var page = await Client.GetFromJsonAsync<EventPageDto>("/world/v1/events", WorldMapJson.Options);
        var surfaced = Assert.Single(page!.Items, e => e.Id == "privacy-evt-1");
        Assert.Null(surfaced.Data);
    }
}
