using System.Text.Json.Serialization;
using System.Threading.RateLimiting;
using Azure.Monitor.OpenTelemetry.AspNetCore;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.FileProviders;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using WorldMap.Api.Endpoints;
using WorldMap.Api.Middleware;
using WorldMap.Api.Sse;
using WorldMap.Api.Telemetry;
using WorldMap.Api.Workers;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Application;
using WorldMap.Core.Configuration;
using WorldMap.Infrastructure;

var builder = WebApplication.CreateBuilder(args);

// --- Options (bound once; the resolved instance also drives provider validation) ---
builder.Services.AddOptions<WorldMapOptions>().BindConfiguration(WorldMapOptions.SectionName);
var options = builder.Configuration.GetSection(WorldMapOptions.SectionName).Get<WorldMapOptions>() ?? new WorldMapOptions();

// --- JSON: match the federation wire format everywhere ---
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
    o.SerializerOptions.PropertyNameCaseInsensitive = true;
});

// --- Core services ---
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddMetrics();
builder.Services.AddSingleton<WorldMapMetrics>();
builder.Services.AddSingleton<CivRateLimiter>();

// Shared SSE broadcaster is fed at commit time via IWorldEventSink (replaces per-client polling).
builder.Services.AddSingleton<SseBroadcaster>();
builder.Services.AddSingleton<IWorldEventSink>(sp => sp.GetRequiredService<SseBroadcaster>());

builder.Services.AddWorldMapInfrastructure(options, builder.Environment.IsDevelopment());
builder.Services.AddWorldMapApplication();
builder.Services.AddHostedService<WorldMaintenanceWorker>();

builder.Services.AddProblemDetails();

// --- Request body size guard ---
builder.WebHost.ConfigureKestrel(k => k.Limits.MaxRequestBodySize = 4 * 1024 * 1024);

// --- Pre-auth GLOBAL rate limiting: partition by NETWORK identity only (never a client header).
//     Health probes are exempt so orchestrators are never throttled. ---
builder.Services.AddRateLimiter(rl =>
{
    rl.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    rl.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(context =>
    {
        var path = context.Request.Path;
        if (path.StartsWithSegments("/health"))
        {
            return RateLimitPartition.GetNoLimiter("health");
        }

        var ip = context.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        return RateLimitPartition.GetSlidingWindowLimiter($"ip:{ip}", _ => new SlidingWindowRateLimiterOptions
        {
            PermitLimit = 600,
            Window = TimeSpan.FromMinutes(1),
            SegmentsPerWindow = 6,
            QueueLimit = 0,
        });
    });
    rl.OnRejected = async (context, ct) =>
    {
        context.HttpContext.Response.ContentType = "application/problem+json";
        await context.HttpContext.Response.WriteAsync(
            "{\"type\":\"about:blank\",\"title\":\"Too Many Requests\",\"status\":429,\"code\":\"rate_limited\",\"retryable\":true}",
            ct);
    };
});

// --- OpenTelemetry (traces + metrics); Azure Monitor exporter optional ---
var otel = builder.Services.AddOpenTelemetry()
    .ConfigureResource(r => r.AddService("WorldMap.Api"))
    .WithTracing(t => t.AddAspNetCoreInstrumentation())
    .WithMetrics(m => m
        .AddAspNetCoreInstrumentation()
        .AddRuntimeInstrumentation()
        .AddMeter(WorldMapMetrics.MeterName));

if (!string.IsNullOrEmpty(options.Telemetry.AzureMonitorConnectionString))
{
    otel.UseAzureMonitor(o => o.ConnectionString = options.Telemetry.AzureMonitorConnectionString);
}

var app = builder.Build();

// Enable request-body buffering up front so the HMAC endpoint filter can re-read the raw body
// bytes AFTER minimal-API model binding has consumed the stream. Without this, signed requests
// that carry a body (POST/PUT) fail signature verification because the filter would hash an
// empty body. Signing headers cap the body at 4 MiB (see Kestrel MaxRequestBodySize above).
app.Use(async (context, next) =>
{
    context.Request.EnableBuffering();
    await next(context);
});

app.UseRateLimiter();

// Serve the observer SPA. When WorldMap:WebRoot is configured (e.g. a publish that dropped the
// built web assets there), static files + the client-route fallback come from that directory;
// otherwise the app's default web root (wwwroot) is used. Federation endpoints and health probes
// are matched first, so this never shadows the API.
IFileProvider? spaProvider = null;
if (!string.IsNullOrWhiteSpace(options.WebRoot) && Directory.Exists(options.WebRoot))
{
    spaProvider = new PhysicalFileProvider(Path.GetFullPath(options.WebRoot));
}

var defaultFilesOptions = new DefaultFilesOptions();
var staticFileOptions = new StaticFileOptions();
if (spaProvider is not null)
{
    defaultFilesOptions.FileProvider = spaProvider;
    staticFileOptions.FileProvider = spaProvider;
}

app.UseDefaultFiles(defaultFilesOptions);
app.UseStaticFiles(staticFileOptions);

app.MapWorldMapApi();

// SPA deep-link fallback: serve index.html only for genuine client-side NAVIGATIONS that didn't
// match an endpoint or a static file. Everything else (API, health, missing assets, non-GET/HEAD,
// non-HTML Accept, file-like paths) keeps proper 404/405/non-index behavior.
var effectiveSpaProvider = spaProvider ?? app.Environment.WebRootFileProvider;
if (effectiveSpaProvider.GetFileInfo("index.html").Exists)
{
    app.MapFallback((HttpContext ctx) =>
    {
        if (!IsSpaNavigation(ctx.Request))
        {
            return Results.NotFound();
        }

        var indexFile = effectiveSpaProvider.GetFileInfo("index.html");
        return indexFile.Exists
            ? Results.File(indexFile.CreateReadStream(), "text/html; charset=utf-8")
            : Results.NotFound();
    });
}

app.Run();

// Decide whether an unmatched request is a client-side navigation that should receive the SPA
// shell. Requires: GET/HEAD, an Accept header that includes text/html, a path outside the API,
// health, and asset roots, and a path whose final segment is not file-like (dotted) — a dotted
// last segment means a missing static asset, which must 404, not return HTML.
static bool IsSpaNavigation(HttpRequest request)
{
    if (!HttpMethods.IsGet(request.Method) && !HttpMethods.IsHead(request.Method))
    {
        return false;
    }

    var path = request.Path.Value ?? "/";
    if (path.StartsWith("/world", StringComparison.OrdinalIgnoreCase) ||
        path.StartsWith("/health", StringComparison.OrdinalIgnoreCase) ||
        path.StartsWith("/assets", StringComparison.OrdinalIgnoreCase))
    {
        return false;
    }

    var lastSlash = path.LastIndexOf('/');
    var lastSegment = lastSlash >= 0 ? path.AsSpan(lastSlash + 1) : path.AsSpan();
    if (lastSegment.Contains('.'))
    {
        return false; // file-like (e.g. /foo.js) — a missing asset, not a route
    }

    // Serve the SPA shell unless the client EXPLICITLY prefers a non-HTML representation.
    // No Accept header (bare GET) or */* → navigation; application/json only → not a navigation.
    var acceptValues = request.Headers.Accept;
    if (acceptValues.Count == 0)
    {
        return true;
    }

    foreach (var accept in acceptValues)
    {
        if (accept is null)
        {
            continue;
        }
        if (accept.Contains("text/html", StringComparison.OrdinalIgnoreCase) ||
            accept.Contains("*/*", StringComparison.Ordinal))
        {
            return true;
        }
    }

    return false;
}

/// <summary>Exposed so integration tests can use <c>WebApplicationFactory&lt;Program&gt;</c>.</summary>
public partial class Program;
