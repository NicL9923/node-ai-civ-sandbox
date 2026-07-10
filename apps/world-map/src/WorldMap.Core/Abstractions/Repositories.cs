using WorldMap.Core.Domain;

namespace WorldMap.Core.Abstractions;

/// <summary>
/// Registry of civilizations. The World is the sole writer. Reads back the citizen-safe
/// projection; writes upsert the full aggregate.
/// </summary>
public interface ICivilizationRepository
{
    Task<Civilization?> GetAsync(string civId, CancellationToken ct);

    Task<Page<Civilization>> ListAsync(long afterOrdinal, int limit, CancellationToken ct);

    Task UpsertAsync(Civilization civilization, CancellationToken ct);

    /// <summary>All civilizations (for the maintenance worker's liveness sweep).</summary>
    Task<IReadOnlyList<Civilization>> ListAllAsync(CancellationToken ct);
}

/// <summary>Stores the S2S HMAC credential (encrypted secret envelope) per civ.</summary>
public interface ICivCredentialRepository
{
    Task<CivCredential?> GetAsync(string civId, CancellationToken ct);

    Task UpsertAsync(CivCredential credential, CancellationToken ct);
}

/// <summary>The interaction ledger. The World is the sole writer.</summary>
public interface IInteractionRepository
{
    Task<Interaction?> GetAsync(string interactionId, CancellationToken ct);

    Task AddAsync(Interaction interaction, CancellationToken ct);

    Task UpdateAsync(Interaction interaction, CancellationToken ct);

    /// <summary>Non-terminal interactions with an <c>expiresAt</c> at or before <paramref name="now"/>.</summary>
    Task<IReadOnlyList<Interaction>> ListExpirableAsync(DateTimeOffset now, CancellationToken ct);
}

/// <summary>Per-civ durable command queue that civs pull from and ack.</summary>
public interface ICommandRepository
{
    Task<Command?> GetAsync(string targetCivId, string commandId, CancellationToken ct);

    Task AddAsync(Command command, CancellationToken ct);

    Task UpdateAsync(Command command, CancellationToken ct);

    /// <summary>Non-expired commands for a civ with sequence &gt; <paramref name="afterSequence"/>, ordered ascending.</summary>
    Task<IReadOnlyList<Command>> PullAsync(string targetCivId, long afterSequence, int limit, CancellationToken ct);

    /// <summary>Count of un-acked, non-expired commands queued for a civ.</summary>
    Task<int> CountPendingAsync(string targetCivId, CancellationToken ct);

    /// <summary>Un-acked commands past their <c>expiresAt</c> (for the maintenance worker).</summary>
    Task<IReadOnlyList<Command>> ListExpirableAsync(DateTimeOffset now, CancellationToken ct);
}

/// <summary>The ordered public world-event ledger backing <c>/events</c> and the SSE stream.</summary>
public interface IWorldEventRepository
{
    Task AddAsync(WorldEvent worldEvent, CancellationToken ct);

    Task<WorldEvent?> GetByDedupeAsync(string dedupeKey, CancellationToken ct);

    /// <summary>Events with worldsequence &gt; <paramref name="afterSequence"/>, ordered ascending.</summary>
    Task<Page<WorldEvent>> ListAsync(long afterSequence, int limit, CancellationToken ct);
}

/// <summary>Public relationship projections. The World is the sole writer.</summary>
public interface IRelationshipRepository
{
    Task<Relationship?> GetAsync(string pairKey, CancellationToken ct);

    Task<Page<Relationship>> ListAsync(long afterOrdinal, int limit, CancellationToken ct);

    Task UpsertAsync(Relationship relationship, CancellationToken ct);
}
