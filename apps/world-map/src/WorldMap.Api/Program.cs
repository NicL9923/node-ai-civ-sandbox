using System.Text.Json.Serialization;
using System.Threading.RateLimiting;
using Azure.Monitor.OpenTelemetry.AspNetCore;
using Microsoft.AspNetCore.Http;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using WorldMap.Api.Endpoints;
using WorldMap.Api.Telemetry;
using WorldMap.Api.Workers;
using WorldMap.Core.Application;
using WorldMap.Core.Configuration;
using WorldMap.Infrastructure;

var builder = WebApplication.CreateBuilder(args);

// --- Options ---
builder.Services.AddOptions<WorldMapOptions>().BindConfiguration(WorldMapOptions.SectionName);
var telemetryConnectionString =
    builder.Configuration[$"{WorldMapOptions.SectionName}:Telemetry:AzureMonitorConnectionString"];

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
builder.Services.AddWorldMapInfrastructure(builder.Configuration);
builder.Services.AddWorldMapApplication();
builder.Services.AddHostedService<WorldMaintenanceWorker>();

// --- Problem details for unhandled failures ---
builder.Services.AddProblemDetails();

// --- Request body size guard (event batch capped at 500 items) ---
builder.WebHost.ConfigureKestrel(k => k.Limits.MaxRequestBodySize = 4 * 1024 * 1024);

// --- Rate limiting: partition by authenticated civ (X-Civ-Id) else client IP ---
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    options.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(context =>
    {
        var partitionKey = context.Request.Headers.TryGetValue("X-Civ-Id", out var civ) && !string.IsNullOrEmpty(civ)
            ? $"civ:{civ}"
            : $"ip:{context.Connection.RemoteIpAddress}";

        return RateLimitPartition.GetSlidingWindowLimiter(partitionKey, _ => new SlidingWindowRateLimiterOptions
        {
            PermitLimit = 300,
            Window = TimeSpan.FromMinutes(1),
            SegmentsPerWindow = 6,
            QueueLimit = 0,
        });
    });
    options.OnRejected = async (context, ct) =>
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

if (!string.IsNullOrEmpty(telemetryConnectionString))
{
    otel.UseAzureMonitor(o => o.ConnectionString = telemetryConnectionString);
}

var app = builder.Build();

// The HMAC auth endpoint filter must hash the raw request body, but minimal-API model
// binding consumes the body stream before endpoint filters run. Enable buffering up front
// so the filter can rewind and read the exact transmitted bytes for signature verification.
app.Use((context, next) =>
{
    context.Request.EnableBuffering();
    return next();
});

app.UseRateLimiter();

// Minimal static placeholder for the future React web app (real UI is a later phase).
app.UseDefaultFiles();
app.UseStaticFiles();

app.MapWorldMapApi();

app.Run();

/// <summary>Exposed so integration tests can use <c>WebApplicationFactory&lt;Program&gt;</c>.</summary>
public partial class Program;
