using System.Net.Http.Headers;
using System.Text;
using WorldMap.Core.Auth;
using WorldMap.Core.Contracts;

namespace WorldMap.IntegrationTests.Harness;

/// <summary>
/// Builds the six federation HMAC signing headers for a request by reusing the PRODUCTION
/// <see cref="HmacCanonicalizer"/> and <see cref="HmacSigner"/> (already validated against the
/// golden vectors). The server hosts routes under a <c>/world/v1</c> MapGroup, so
/// <c>request.Path</c> already includes <c>/world/v1</c>; callers therefore sign — and send to —
/// the full <c>/world/v1/...</c> path.
/// </summary>
public static class Signing
{
    /// <summary>
    /// Computes the signing headers for a request. <paramref name="idempotencyKey"/> is the
    /// empty string for reads (it participates in the canonical string either way; the
    /// <c>Idempotency-Key</c> header is only emitted when non-empty).
    /// </summary>
    public static IReadOnlyDictionary<string, string> BuildHeaders(
        string method,
        string path,
        string rawQuery,
        byte[] body,
        string civId,
        string keyId,
        string secret,
        string idempotencyKey = "",
        long? timestamp = null,
        string? nonce = null)
    {
        var ts = (timestamp ?? DateTimeOffset.UtcNow.ToUnixTimeSeconds()).ToString();
        var nonceValue = nonce ?? Guid.NewGuid().ToString("N");

        var signed = new HmacSignedRequest(
            ProtocolVersion: HmacCanonicalizer.ProtocolVersion,
            CivId: civId,
            KeyId: keyId,
            Timestamp: ts,
            Nonce: nonceValue,
            IdempotencyKey: idempotencyKey,
            Method: method,
            Path: path,
            RawQuery: rawQuery,
            Body: body);

        var canonical = HmacCanonicalizer.BuildCanonicalString(signed);
        var signature = HmacSigner.Sign(canonical, secret);

        var headers = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["X-Protocol-Version"] = HmacCanonicalizer.ProtocolVersion,
            ["X-Civ-Id"] = civId,
            ["X-Key-Id"] = keyId,
            ["X-Timestamp"] = ts,
            ["X-Nonce"] = nonceValue,
            ["X-Signature"] = signature,
        };

        if (!string.IsNullOrEmpty(idempotencyKey))
        {
            headers["Idempotency-Key"] = idempotencyKey;
        }

        return headers;
    }

    /// <summary>
    /// Builds a fully-signed <see cref="HttpRequestMessage"/> targeting <c>{path}?{rawQuery}</c>
    /// with the given JSON body bytes (empty for reads). The exact bytes signed are the exact
    /// bytes sent so the server hashes an identical body.
    /// </summary>
    public static HttpRequestMessage BuildSignedRequest(
        HttpMethod method,
        string path,
        string rawQuery,
        byte[] body,
        string civId,
        string keyId,
        string secret,
        string idempotencyKey = "",
        long? timestamp = null,
        string? nonce = null)
    {
        var headers = BuildHeaders(
            method.Method, path, rawQuery, body, civId, keyId, secret, idempotencyKey, timestamp, nonce);

        return Assemble(method, path, rawQuery, body, headers, sendBody: method != HttpMethod.Get);
    }

    /// <summary>
    /// Builds an <see cref="HttpRequestMessage"/> from a pre-computed header set. Useful for
    /// negative tests that tamper with the body, headers, or signature after signing.
    /// </summary>
    public static HttpRequestMessage Assemble(
        HttpMethod method,
        string path,
        string rawQuery,
        byte[] body,
        IReadOnlyDictionary<string, string> headers,
        bool sendBody)
    {
        var uri = string.IsNullOrEmpty(rawQuery) ? path : $"{path}?{rawQuery}";
        var message = new HttpRequestMessage(method, new Uri(uri, UriKind.Relative));

        if (sendBody)
        {
            var content = new ByteArrayContent(body);
            content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
            message.Content = content;
        }

        foreach (var (name, value) in headers)
        {
            message.Headers.TryAddWithoutValidation(name, value);
        }

        return message;
    }

    /// <summary>Serializes a DTO to the exact UTF-8 bytes used for signing and transmission.</summary>
    public static byte[] SerializeBody(object value) =>
        Encoding.UTF8.GetBytes(System.Text.Json.JsonSerializer.Serialize(value, value.GetType(), WorldMapJson.Options));
}
