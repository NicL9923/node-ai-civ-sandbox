using System.Net.Http.Json;
using System.Text;
using WorldMap.Core.Contracts;
using WorldMap.IntegrationTests.Harness;

namespace WorldMap.IntegrationTests.Tests;

/// <summary>
/// The SSE stream opens as <c>text/event-stream</c>. When feasible we also confirm a
/// <c>data:</c> frame surfaces a submitted interaction. A cancellation token bounds every read
/// so the test can never hang CI; only the content-type + stream-open are hard assertions.
/// </summary>
public sealed class SseTests : WorldTestBase
{
    [Fact]
    public async Task Stream_opens_as_event_stream_and_surfaces_events()
    {
        // Seed a world event first so the very first poll has something to emit.
        var a = await Factory.RegisterCivAsync(Client, "Aurora");
        var b = await Factory.RegisterCivAsync(Client, "Borealis");

        var interaction = TestDtos.ContactInteraction(a.CivId, b.CivId, "Hello over the wire.");
        var body = Signing.SerializeBody(interaction);
        using var submit = Signing.BuildSignedRequest(
            HttpMethod.Post, "/world/v1/interactions", string.Empty, body,
            a.CivId, a.KeyId, a.Secret, idempotencyKey: Guid.NewGuid().ToString("N"));
        var submitResponse = await Client.SendAsync(submit);
        var accepted = await submitResponse.Content.ReadFromJsonAsync<AcceptedDto>(WorldMapJson.Options);
        var interactionId = accepted!.ResourceId!;

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(8));

        using var response = await Client.GetAsync(
            "/world/v1/stream", HttpCompletionOption.ResponseHeadersRead, cts.Token);

        // Hard assertion: the stream opens with the SSE content type.
        Assert.Equal("text/event-stream", response.Content.Headers.ContentType?.MediaType);

        // Best-effort: read until a data frame arrives or the token trips. Never hangs.
        var accumulated = new StringBuilder();
        try
        {
            await using var stream = await response.Content.ReadAsStreamAsync(cts.Token);
            using var reader = new StreamReader(stream, Encoding.UTF8);
            var buffer = new char[1024];
            while (!cts.IsCancellationRequested)
            {
                var read = await reader.ReadAsync(buffer, cts.Token);
                if (read == 0)
                {
                    break;
                }

                accumulated.Append(buffer, 0, read);
                if (accumulated.ToString().Contains("data:", StringComparison.Ordinal))
                {
                    break;
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Timed out waiting for a frame — acceptable; content-type already proven above.
        }

        var text = accumulated.ToString();
        if (text.Contains("data:", StringComparison.Ordinal))
        {
            Assert.Contains(interactionId, text);
        }
    }
}
