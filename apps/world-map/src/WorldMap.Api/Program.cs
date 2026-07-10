using System.Text.Json.Serialization;
using System.Threading.RateLimiting;
using Azure.Monitor.OpenTelemetry.AspNetCore;
using Microsoft.AspNetCore.Http;
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

// Minimal static placeholder for the future React web app (real UI is a later phase).
app.UseDefaultFiles();
app.UseStaticFiles();

app.MapWorldMapApi();

app.Run();

/// <summary>Exposed so integration tests can use <c>WebApplicationFactory&lt;Program&gt;</c>.</summary>
public partial class Program;
