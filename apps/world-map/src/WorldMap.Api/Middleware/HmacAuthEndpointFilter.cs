using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using WorldMap.Api.Results;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Auth;
using WorldMap.Core.Common;

namespace WorldMap.Api.Middleware;

/// <summary>
/// Endpoint filter enforcing HMAC-SHA256 request signing exactly per the federation spec.
/// Buffers the raw body to hash it, rebuilds the 10-field canonical string, verifies the
/// signature (constant-time) against the civ's stored secret, enforces the ±300s window
/// and single-use nonce, and checks that <c>X-Civ-Id</c> matches the route <c>civId</c>.
/// On success it publishes an <see cref="AuthContext"/> for the endpoint.
/// </summary>
public sealed class HmacAuthEndpointFilter : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var http = context.HttpContext;
        var request = http.Request;
        var ct = http.RequestAborted;

        var services = http.RequestServices;
        var credentials = services.GetRequiredService<ICivCredentialRepository>();
        var secretStore = services.GetRequiredService<ISecretStore>();
        var nonceStore = services.GetRequiredService<INonceStore>();
        var clock = services.GetRequiredService<TimeProvider>();
        var logger = services.GetRequiredService<ILogger<HmacAuthEndpointFilter>>();
        var metrics = services.GetService<WorldMap.Api.Telemetry.WorldMapMetrics>();

        IResult Fail(ErrorCode code, string message, string reason)
        {
            metrics?.RecordAuthFailure(reason);
            return ApiResults.Problem(ErrorResult.Create(code, message), http);
        }

        // Required signing headers.
        if (!TryHeader(request, "X-Protocol-Version", out var protocolVersion) ||
            !TryHeader(request, "X-Civ-Id", out var civId) ||
            !TryHeader(request, "X-Key-Id", out var keyId) ||
            !TryHeader(request, "X-Timestamp", out var timestamp) ||
            !TryHeader(request, "X-Nonce", out var nonce) ||
            !TryHeader(request, "X-Signature", out var signature))
        {
            return Fail(ErrorCode.Unauthorized, "Missing one or more required signing headers.", "missing_headers");
        }

        if (protocolVersion != HmacCanonicalizer.ProtocolVersion)
        {
            return Fail(ErrorCode.Unauthorized, "Unsupported protocol version.", "bad_protocol_version");
        }

        var idempotencyKey = request.Headers.TryGetValue("Idempotency-Key", out var idem)
            ? idem.ToString()
            : string.Empty;

        // Enforce X-Civ-Id matches the route civId when present.
        if (request.RouteValues.TryGetValue("civId", out var routeCiv) && routeCiv is string rc && rc != civId)
        {
            return Fail(ErrorCode.CivIdMismatch, "X-Civ-Id does not match the civId in the request path.", "civ_id_mismatch");
        }

        // Clock skew (±300s).
        if (!long.TryParse(timestamp, out var ts))
        {
            return Fail(ErrorCode.ClockSkew, "X-Timestamp is not a valid Unix epoch seconds value.", "bad_timestamp");
        }

        var now = clock.GetUtcNow();
        var nowSeconds = now.ToUnixTimeSeconds();

        // Overflow-safe range check: never do arithmetic on the untrusted `ts` (e.g. long.MinValue
        // would overflow Math.Abs and throw -> 500). Compare against precomputed bounds instead.
        var lowerBound = nowSeconds - HmacCanonicalizer.ReplayWindowSeconds;
        var upperBound = nowSeconds + HmacCanonicalizer.ReplayWindowSeconds;
        if (ts < lowerBound || ts > upperBound)
        {
            return Fail(ErrorCode.ClockSkew, "X-Timestamp is outside the allowed window.", "clock_skew");
        }

        // Buffer the raw body so we can hash the exact transmitted bytes, then rewind.
        // Minimal-API model binding runs before endpoint filters and consumes the body
        // stream, so rewind to the start before reading (buffering is enabled up front by
        // Program.cs middleware so the buffered bytes are still available here).
        request.EnableBuffering();
        request.Body.Position = 0;
        byte[] body;
        using (var ms = new MemoryStream())
        {
            await request.Body.CopyToAsync(ms, ct);
            body = ms.ToArray();
        }

        request.Body.Position = 0;

        // Resolve the signing secret for (civId, keyId) via its stored reference.
        var credential = await credentials.GetAsync(civId, ct);
        if (credential is null || !credential.Active || credential.KeyId != keyId)
        {
            return Fail(ErrorCode.InvalidSignature, "Unknown civilization or signing key.", "unknown_key");
        }

        var secret = secretStore.GetSecret(credential.SecretRef);
        if (string.IsNullOrEmpty(secret))
        {
            logger.LogWarning("No secret resolved for {CivId} (secretRef unprovisioned).", civId);
            return Fail(ErrorCode.InvalidSignature, "Unable to verify signature.", "secret_unresolved");
        }

        var fullPath = (request.PathBase + request.Path).ToString();
        var canonical = HmacCanonicalizer.BuildCanonicalString(new HmacSignedRequest(
            ProtocolVersion: protocolVersion,
            CivId: civId,
            KeyId: keyId,
            Timestamp: timestamp,
            Nonce: nonce,
            IdempotencyKey: idempotencyKey,
            Method: request.Method,
            Path: fullPath,
            RawQuery: request.QueryString.Value ?? string.Empty,
            Body: body));

        if (!HmacSigner.Verify(canonical, secret, signature))
        {
            logger.LogInformation("HMAC verification failed for {CivId} ({Method} {Path}).", civId, request.Method, fullPath);
            return Fail(ErrorCode.InvalidSignature, "Invalid request signature.", "bad_signature");
        }

        // Single-use nonce within the replay window. Scope by civId+keyId+nonce; the entry's expiry
        // is derived from the SIGNED timestamp (not verification time) so a future-dated valid
        // request cannot be replayed after an early expiry.
        var nonceExpiry = DateTimeOffset.FromUnixTimeSeconds(ts).AddSeconds(HmacCanonicalizer.ReplayWindowSeconds);

        // Reject a request whose signed replay window has already elapsed. Without this, a request at
        // the oldest accepted whole-second timestamp would store a nonce that is already expired,
        // letting it be replayed within that second.
        if (nonceExpiry <= now)
        {
            return Fail(ErrorCode.ClockSkew, "The request's signed replay window has already elapsed.", "clock_skew");
        }

        if (!await nonceStore.TryConsumeAsync(civId, keyId, nonce, nonceExpiry, now, ct))
        {
            return Fail(ErrorCode.ReplayDetected, "Nonce has already been used within the replay window.", "replay");
        }

        // Post-auth, per-civ rate limiting keyed by the VERIFIED civ id.
        var civRateLimiter = services.GetService<CivRateLimiter>();
        if (civRateLimiter is not null && !await civRateLimiter.TryAcquireAsync(civId))
        {
            metrics?.RecordAuthFailure("civ_rate_limited");
            return ApiResults.Problem(ErrorResult.Create(ErrorCode.RateLimited, "Per-civilization rate limit exceeded."), http);
        }

        http.Items[AuthContext.HttpContextItemKey] = new AuthContext(civId, keyId, idempotencyKey);
        return await next(context);
    }

    private static bool TryHeader(HttpRequest request, string name, out string value)
    {
        if (request.Headers.TryGetValue(name, out var v) && !string.IsNullOrEmpty(v.ToString()))
        {
            value = v.ToString();
            return true;
        }

        value = string.Empty;
        return false;
    }
}
