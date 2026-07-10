using System.Net;
using System.Net.Http.Json;
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
}
