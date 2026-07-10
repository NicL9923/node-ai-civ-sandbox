using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Common;
using WorldMap.Core.Configuration;
using WorldMap.Core.Contracts;

namespace WorldMap.Core.Application.Impl;

/// <summary>
/// Civilization liveness (heartbeat) and citizen-safe public projection reads. The World
/// is the sole writer; heartbeats refresh the projection and freshness timestamp.
/// </summary>
public sealed class CivilizationService(
    ICivilizationRepository civilizations,
    ICommandRepository commands,
    TimeProvider clock,
    IOptions<WorldMapOptions> options,
    ILogger<CivilizationService> logger) : ICivilizationService
{
    private readonly WorldMapOptions _options = options.Value;

    public async Task<Result<HeartbeatAckDto>> HeartbeatAsync(string civId, HeartbeatDto request, CancellationToken ct)
    {
        if (request.Projection is null)
        {
            return ErrorResult.Create(ErrorCode.ValidationFailed, "Heartbeat requires a projection.",
                errors: [new FieldError("/projection", "projection is required.")]);
        }

        var civ = await civilizations.GetAsync(civId, ct);
        if (civ is null)
        {
            return ErrorResult.Create(ErrorCode.CivilizationNotFound, $"Civilization '{civId}' not found.");
        }

        var now = clock.GetUtcNow();
        var projection = request.Projection;

        civ.Turn = projection.Turn;
        civ.Running = projection.Running;
        civ.Population = projection.Population;
        civ.President = projection.President;
        civ.Economy = projection.Economy;
        civ.LastProcessedWorldCursor = request.LastProcessedWorldCursor ?? projection.LastProcessedWorldCursor;
        civ.ProjectionUpdatedAt = projection.UpdatedAt;
        if (request.Capabilities is not null)
        {
            civ.Capabilities = request.Capabilities;
        }

        civ.LastHeartbeatAt = now;
        civ.UpdatedAt = now;
        await civilizations.UpsertAsync(civ, ct);

        var pending = await commands.CountPendingAsync(civId, ct);
        logger.LogDebug("Heartbeat accepted for {CivId}; {Pending} pending commands.", civId, pending);

        return new HeartbeatAckDto
        {
            CivId = civId,
            ServerTime = now,
            NextHeartbeatInSeconds = _options.Liveness.SuggestedHeartbeatSeconds,
            PendingCommandCount = pending,
            CommandsCursor = null,
        };
    }

    public async Task<Result<CivilizationListPageDto>> ListAsync(string? after, int? limit, CancellationToken ct)
    {
        if (!CursorCodec.TryDecode(after, out var afterOrdinal))
        {
            return ErrorResult.Create(ErrorCode.ValidationFailed, "Invalid 'after' cursor.");
        }

        var page = await civilizations.ListAsync(afterOrdinal, Pagination.ClampLimit(limit), ct);
        return new CivilizationListPageDto
        {
            Items = page.Items.Select(c => c.ToProjection()).ToList(),
            NextCursor = page.NextOrdinal is { } o ? CursorCodec.Encode(o) : null,
        };
    }

    public async Task<Result<PublicProjectionDto>> GetAsync(string civId, CancellationToken ct)
    {
        var civ = await civilizations.GetAsync(civId, ct);
        return civ is null
            ? ErrorResult.Create(ErrorCode.CivilizationNotFound, $"Civilization '{civId}' not found.")
            : civ.ToProjection();
    }
}
