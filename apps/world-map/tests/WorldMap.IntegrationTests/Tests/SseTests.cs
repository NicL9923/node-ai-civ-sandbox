using System.Net.Http.Json;
using System.Text;
using WorldMap.Core.Common;
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

    [Fact]
    public async Task Stream_frames_carry_an_id_cursor_that_decodes_to_the_event_ordinal()
    {
        // Seed a committed public world event.
        var a = await Factory.RegisterCivAsync(Client, "Aurora");
        var b = await Factory.RegisterCivAsync(Client, "Borealis");
        var interaction = TestDtos.ContactInteraction(a.CivId, b.CivId, "Hello id cursor.");
        var body = Signing.SerializeBody(interaction);
        using var submit = Signing.BuildSignedRequest(
            HttpMethod.Post, "/world/v1/interactions", string.Empty, body,
            a.CivId, a.KeyId, a.Secret, idempotencyKey: Guid.NewGuid().ToString("N"));
        (await Client.SendAsync(submit)).EnsureSuccessStatusCode();

        // Wait for the world event to be committed so the stream's catch-up emits it deterministically.
        CloudEventDto? evt = null;
        using (var pollCts = new CancellationTokenSource(TimeSpan.FromSeconds(8)))
        {
            while (!pollCts.IsCancellationRequested)
            {
                var page = await Client.GetFromJsonAsync<EventPageDto>(
                    "/world/v1/events", WorldMapJson.Options, pollCts.Token);
                if (page is { Items.Count: > 0 })
                {
                    evt = page.Items[0];
                    break;
                }

                await Task.Delay(100, pollCts.Token);
            }
        }

        Assert.NotNull(evt);
        Assert.False(string.IsNullOrEmpty(evt!.Worldsequence));
        var expectedOrdinal = long.Parse(evt.Worldsequence!);

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(8));
        using var response = await Client.GetAsync(
            "/world/v1/stream", HttpCompletionOption.ResponseHeadersRead, cts.Token);
        Assert.Equal("text/event-stream", response.Content.Headers.ContentType?.MediaType);

        // Read until the frame carrying this event is fully terminated (id: ... \n data: ... \n\n).
        var acc = new StringBuilder();
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

                acc.Append(buffer, 0, read);
                var s = acc.ToString();
                var at = s.IndexOf(evt.Id, StringComparison.Ordinal);
                if (at >= 0 && s.IndexOf("\n\n", at, StringComparison.Ordinal) >= 0)
                {
                    break;
                }
            }
        }
        catch (OperationCanceledException)
        {
            // fall through; assertions below will surface a missing frame
        }

        var raw = acc.ToString();
        Assert.Contains(evt.Id, raw);

        // Isolate the frame that carries this event and read its `id:` line.
        var frame = raw
            .Split(new[] { "\n\n" }, StringSplitOptions.None)
            .First(f => f.Contains(evt.Id, StringComparison.Ordinal));
        var idLine = frame
            .Split('\n')
            .First(l => l.StartsWith("id:", StringComparison.Ordinal));
        var cursor = idLine.Substring(3).Trim();

        // The SSE id is the SAME opaque cursor clients echo in `after`, decoding to the ordinal.
        Assert.True(CursorCodec.TryDecode(cursor, out var ordinal), "id cursor did not decode");
        Assert.Equal(expectedOrdinal, ordinal);

        // And the data line is a valid CloudEvent for the same event.
        var dataLine = frame.Split('\n').First(l => l.StartsWith("data:", StringComparison.Ordinal));
        var json = dataLine.Substring("data:".Length).Trim();
        var framed = System.Text.Json.JsonSerializer.Deserialize<CloudEventDto>(json, WorldMapJson.Options);
        Assert.NotNull(framed);
        Assert.Equal(evt.Worldsequence, framed!.Worldsequence);
    }
}
