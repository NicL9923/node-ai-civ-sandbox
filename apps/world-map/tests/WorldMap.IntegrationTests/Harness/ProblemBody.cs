using System.Net.Http.Json;
using System.Text.Json;

namespace WorldMap.IntegrationTests.Harness;

/// <summary>A parsed RFC 7807 <c>application/problem+json</c> body.</summary>
public sealed record ProblemBody(int? Status, string? Code, bool? Retryable, string? Detail, JsonElement Raw)
{
    /// <summary>Reads and parses a problem+json body, asserting the media type is correct.</summary>
    public static async Task<ProblemBody> ReadAsync(HttpResponseMessage response, CancellationToken ct = default)
    {
        var mediaType = response.Content.Headers.ContentType?.MediaType;
        Assert.Equal("application/problem+json", mediaType);

        var text = await response.Content.ReadAsStringAsync(ct);
        using var doc = JsonDocument.Parse(text);
        var root = doc.RootElement.Clone();

        int? status = root.TryGetProperty("status", out var s) && s.ValueKind == JsonValueKind.Number ? s.GetInt32() : null;
        string? code = root.TryGetProperty("code", out var c) && c.ValueKind == JsonValueKind.String ? c.GetString() : null;
        bool? retryable = root.TryGetProperty("retryable", out var r) && (r.ValueKind == JsonValueKind.True || r.ValueKind == JsonValueKind.False)
            ? r.GetBoolean()
            : null;
        string? detail = root.TryGetProperty("detail", out var d) && d.ValueKind == JsonValueKind.String ? d.GetString() : null;

        return new ProblemBody(status, code, retryable, detail, root);
    }
}
