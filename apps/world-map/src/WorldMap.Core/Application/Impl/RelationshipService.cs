using WorldMap.Core.Abstractions;
using WorldMap.Core.Common;
using WorldMap.Core.Contracts;
using WorldMap.Core.Domain;

namespace WorldMap.Core.Application.Impl;

/// <summary>
/// Public relationship projections. Without a pair, returns a cursor-paginated list; with
/// both <c>civA</c> and <c>civB</c>, returns the single canonical-pair relationship as a
/// one-item page.
/// </summary>
public sealed class RelationshipService(IRelationshipRepository relationships) : IRelationshipService
{
    public async Task<Result<RelationshipPageDto>> ListAsync(
        string? after,
        int? limit,
        string? civA,
        string? civB,
        CancellationToken ct)
    {
        var hasA = !string.IsNullOrWhiteSpace(civA);
        var hasB = !string.IsNullOrWhiteSpace(civB);

        if (hasA ^ hasB)
        {
            return ErrorResult.Create(ErrorCode.ValidationFailed, "civA and civB must be provided together.");
        }

        if (hasA && hasB)
        {
            var pairKey = Relationship.PairKeyFor(civA!, civB!);
            var relationship = await relationships.GetAsync(pairKey, ct);
            return relationship is null
                ? ErrorResult.Create(ErrorCode.RelationshipNotFound, $"No relationship exists between '{civA}' and '{civB}'.")
                : new RelationshipPageDto { Items = [relationship.ToDto()], NextCursor = null };
        }

        if (!CursorCodec.TryDecode(after, out var afterOrdinal))
        {
            return ErrorResult.Create(ErrorCode.ValidationFailed, "Invalid 'after' cursor.");
        }

        var page = await relationships.ListAsync(afterOrdinal, Pagination.ClampLimit(limit), ct);
        return new RelationshipPageDto
        {
            Items = page.Items.Select(r => r.ToDto()).ToList(),
            NextCursor = page.NextOrdinal is { } o ? CursorCodec.Encode(o) : null,
        };
    }
}
