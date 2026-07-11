using WorldMap.Core.Abstractions;
using WorldMap.Core.Domain;

namespace WorldMap.UnitTests.Fakes;

internal sealed class ThrowOnceAfterWorldEventAppend(IWorldEventRepository inner) : IWorldEventRepository
{
    private int _remaining = 1;

    public async Task<WorldEventAppend> AppendAsync(WorldEvent worldEvent, CancellationToken ct)
    {
        var result = await inner.AppendAsync(worldEvent, ct);
        if (Interlocked.Exchange(ref _remaining, 0) == 1)
        {
            throw new InjectedFailureException();
        }

        return result;
    }

    public Task<WorldEvent?> GetByDedupeAsync(string dedupeKey, CancellationToken ct) =>
        inner.GetByDedupeAsync(dedupeKey, ct);

    public Task<Page<WorldEvent>> ListAsync(long afterSequence, int limit, CancellationToken ct) =>
        inner.ListAsync(afterSequence, limit, ct);
}

internal sealed class ThrowOnceAfterRelationshipUpsert(IRelationshipRepository inner) : IRelationshipRepository
{
    private int _remaining = 1;

    public Task<Relationship?> GetAsync(string pairKey, CancellationToken ct) => inner.GetAsync(pairKey, ct);

    public async Task<bool> TryUpsertAsync(Relationship relationship, CancellationToken ct)
    {
        var result = await inner.TryUpsertAsync(relationship, ct);
        if (Interlocked.Exchange(ref _remaining, 0) == 1)
        {
            throw new InjectedFailureException();
        }

        return result;
    }

    public Task<Page<Relationship>> ListAsync(long afterOrdinal, int limit, CancellationToken ct) =>
        inner.ListAsync(afterOrdinal, limit, ct);
}

internal sealed class ThrowOnceAfterCommandEnqueue(ICommandRepository inner) : ICommandRepository
{
    private int _remaining = 1;

    public Task<Command?> GetAsync(string targetCivId, string commandId, CancellationToken ct) =>
        inner.GetAsync(targetCivId, commandId, ct);

    public async Task<Command> EnqueueAsync(Command command, CancellationToken ct)
    {
        var result = await inner.EnqueueAsync(command, ct);
        if (Interlocked.Exchange(ref _remaining, 0) == 1)
        {
            throw new InjectedFailureException();
        }

        return result;
    }

    public Task<CommandAckTransition> TryAckAsync(string targetCivId, string commandId, CommandAckStatus status, DateTimeOffset now, CancellationToken ct) =>
        inner.TryAckAsync(targetCivId, commandId, status, now, ct);
    public Task MarkAckReconciledAsync(string targetCivId, string commandId, CancellationToken ct) =>
        inner.MarkAckReconciledAsync(targetCivId, commandId, ct);
    public Task<bool> MarkExpiredAsync(string targetCivId, string commandId, CancellationToken ct) =>
        inner.MarkExpiredAsync(targetCivId, commandId, ct);
    public Task<IReadOnlyList<Command>> PullAsync(string targetCivId, long afterSequence, int limit, CancellationToken ct) =>
        inner.PullAsync(targetCivId, afterSequence, limit, ct);
    public Task<int> CountPendingAsync(string targetCivId, CancellationToken ct) =>
        inner.CountPendingAsync(targetCivId, ct);
    public Task<IReadOnlyList<Command>> ListExpirableAsync(DateTimeOffset now, CancellationToken ct) =>
        inner.ListExpirableAsync(now, ct);
    public Task<IReadOnlyList<Command>> ListUnreconciledAsync(CancellationToken ct) =>
        inner.ListUnreconciledAsync(ct);
}

internal sealed class ThrowOnceAfterTokenReserve(IOnboardingTokenStore inner) : IOnboardingTokenStore
{
    private int _remaining = 1;

    public async Task<OnboardingReservationOutcome> ReserveAsync(string tokenHash, string civId, string fingerprint, CancellationToken ct)
    {
        var result = await inner.ReserveAsync(tokenHash, civId, fingerprint, ct);
        if (Interlocked.Exchange(ref _remaining, 0) == 1)
        {
            throw new InjectedFailureException();
        }

        return result;
    }
}

internal sealed class InjectedFailureException : Exception;
