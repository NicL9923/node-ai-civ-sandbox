using WorldMap.Core.Domain;

namespace WorldMap.Core.Abstractions;

/// <summary>
/// Registry of civilizations. The World is the sole writer. The repository assigns a stable
/// monotonic <c>Ordinal</c> at first insert (allocate-through-insert), so list pagination never
/// exposes a cursor position past a civ that has not yet been persisted.
/// </summary>
public interface ICivilizationRepository
{
    Task<Civilization?> GetAsync(string civId, CancellationToken ct);

    Task<Page<Civilization>> ListAsync(long afterOrdinal, int limit, CancellationToken ct);

    /// <summary>Upserts a civ. On first insert the repository assigns <c>Ordinal</c> atomically.</summary>
    Task UpsertAsync(Civilization civilization, CancellationToken ct);

    /// <summary>All civilizations (for the maintenance worker's liveness sweep).</summary>
    Task<IReadOnlyList<Civilization>> ListAllAsync(CancellationToken ct);
}

/// <summary>Stores the S2S HMAC credential (civId/keyId/secretRef) per civ. No secret material.</summary>
public interface ICivCredentialRepository
{
    Task<CivCredential?> GetAsync(string civId, CancellationToken ct);

    Task UpsertAsync(CivCredential credential, CancellationToken ct);
}

/// <summary>
/// The interaction ledger. The World is the sole writer. Interactions are persisted in an
/// <c>accepted</c> state before any downstream effect; the process manager advances them through
/// idempotent steps. <see cref="UpdateAsync"/> uses optimistic concurrency on <c>Version</c>.
/// </summary>
public interface IInteractionRepository
{
    Task<Interaction?> GetAsync(string interactionId, CancellationToken ct);

    Task AddAsync(Interaction interaction, CancellationToken ct);

    /// <summary>
    /// Optimistic-concurrency update. Returns <c>true</c> on success, <c>false</c> if the stored
    /// version moved on (the caller should reload and retry).
    /// </summary>
    Task<bool> UpdateAsync(Interaction interaction, CancellationToken ct);

    /// <summary>Non-terminal interactions whose processing has not reached <c>Queued</c> (worker resume).</summary>
    Task<IReadOnlyList<Interaction>> ListIncompleteAsync(CancellationToken ct);

    /// <summary>Non-terminal interactions with an <c>effectiveExpiresAt</c> at or before <paramref name="now"/>.</summary>
    Task<IReadOnlyList<Interaction>> ListExpirableAsync(DateTimeOffset now, CancellationToken ct);
}

/// <summary>
/// Per-civ durable command queue. <see cref="EnqueueAsync"/> assigns the per-civ
/// <c>CommandSequence</c> atomically at insert and is idempotent by the deterministic
/// <c>CommandId</c>. <see cref="TryAckAsync"/> is a compare-and-set terminal transition.
/// </summary>
public interface ICommandRepository
{
    Task<Command?> GetAsync(string targetCivId, string commandId, CancellationToken ct);

    /// <summary>
    /// Atomically assigns <c>CommandSequence</c> and inserts. If a command with the same
    /// <c>CommandId</c> already exists, returns the existing one (idempotent enqueue).
    /// </summary>
    Task<Command> EnqueueAsync(Command command, CancellationToken ct);

    /// <summary>
    /// Compare-and-set the terminal ack transition. Mutually exclusive with expiry: an ACK wins only
    /// if the command is neither already acked nor already terminally expired. Returns the outcome and
    /// the authoritative command.
    /// </summary>
    Task<CommandAckTransition> TryAckAsync(string targetCivId, string commandId, CommandAckStatus status, DateTimeOffset now, CancellationToken ct);

    /// <summary>Marks a command's ack propagation to its interaction as reconciled.</summary>
    Task MarkAckReconciledAsync(string targetCivId, string commandId, CancellationToken ct);

    /// <summary>
    /// Compare-and-set the terminal expiry transition. Wins only if the command is neither acked nor
    /// already expired. Returns <c>true</c> only when THIS call performed the transition — so the
    /// caller advances the linked interaction to expired only when expiry actually won (never when an
    /// ACK already won the race).
    /// </summary>
    Task<bool> MarkExpiredAsync(string targetCivId, string commandId, CancellationToken ct);

    /// <summary>
    /// Non-expired, un-acked commands for a civ with sequence &gt; <paramref name="afterSequence"/>,
    /// ordered ascending. Terminal (acked) and expired commands are never returned.
    /// </summary>
    Task<IReadOnlyList<Command>> PullAsync(string targetCivId, long afterSequence, int limit, CancellationToken ct);

    /// <summary>Count of un-acked, non-expired commands queued for a civ.</summary>
    Task<int> CountPendingAsync(string targetCivId, CancellationToken ct);

    /// <summary>Un-acked commands past their <c>expiresAt</c> (for the maintenance worker).</summary>
    Task<IReadOnlyList<Command>> ListExpirableAsync(DateTimeOffset now, CancellationToken ct);

    /// <summary>Acked commands whose interaction reconciliation has not completed (worker repair).</summary>
    Task<IReadOnlyList<Command>> ListUnreconciledAsync(CancellationToken ct);
}

/// <summary>Outcome of a mutually-exclusive command terminal transition.</summary>
public enum CommandAckOutcome
{
    /// <summary>This ACK won the terminal transition; the command is now acked.</summary>
    Applied,

    /// <summary>The command was already acked; a replay observes the same terminal outcome.</summary>
    AlreadyAcked,

    /// <summary>The command had already terminally expired; the ACK loses and is rejected.</summary>
    Expired,
}

/// <summary>Result of a compare-and-set command ack transition.</summary>
public readonly record struct CommandAckTransition(CommandAckOutcome Outcome, Command Command)
{
    /// <summary>True only when this call performed the winning ack transition.</summary>
    public bool Won => Outcome == CommandAckOutcome.Applied;
}

/// <summary>
/// The ordered public world-event ledger backing <c>/events</c> and the SSE stream.
/// <see cref="AppendAsync"/> assigns the global <c>Worldsequence</c> atomically at insert
/// (allocate-through-insert) and is idempotent by <c>DedupeKey</c>, so the read cursor never
/// advances past a sequence whose record is not yet committed.
/// </summary>
public interface IWorldEventRepository
{
    /// <summary>
    /// Atomically assigns <c>Worldsequence</c> and inserts. If an event with the same
    /// <c>DedupeKey</c> already exists, returns the existing one with <c>WasDuplicate</c> true
    /// (idempotent append).
    /// </summary>
    Task<WorldEventAppend> AppendAsync(WorldEvent worldEvent, CancellationToken ct);

    Task<WorldEvent?> GetByDedupeAsync(string dedupeKey, CancellationToken ct);

    /// <summary>Committed events with worldsequence &gt; <paramref name="afterSequence"/>, ascending.</summary>
    Task<Page<WorldEvent>> ListAsync(long afterSequence, int limit, CancellationToken ct);
}

/// <summary>Result of a world-event append: the committed (or pre-existing) event and a dedupe flag.</summary>
public readonly record struct WorldEventAppend(WorldEvent Event, bool WasDuplicate);

/// <summary>
/// Public relationship projections. The World is the sole writer. The repository assigns a stable
/// <c>Ordinal</c> at first insert; <see cref="TryUpsertAsync"/> uses optimistic concurrency on
/// <c>Version</c> so a concurrent update cannot silently clobber a newer state.
/// </summary>
public interface IRelationshipRepository
{
    Task<Relationship?> GetAsync(string pairKey, CancellationToken ct);

    Task<Page<Relationship>> ListAsync(long afterOrdinal, int limit, CancellationToken ct);

    /// <summary>
    /// Optimistic-concurrency upsert. On first insert assigns <c>Ordinal</c>. Returns <c>false</c>
    /// if the stored version moved on (caller reloads and retries).
    /// </summary>
    Task<bool> TryUpsertAsync(Relationship relationship, CancellationToken ct);
}
