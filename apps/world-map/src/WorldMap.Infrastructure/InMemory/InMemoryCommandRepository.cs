using WorldMap.Core.Abstractions;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.InMemory;

/// <summary>
/// Thread-safe in-memory per-civ command queue. <see cref="EnqueueAsync"/> assigns the per-civ
/// <c>CommandSequence</c> and inserts atomically under a lock (allocate-through-insert), idempotent
/// by <c>CommandId</c>. <see cref="TryAckAsync"/> is a compare-and-set terminal transition so
/// concurrent different acks cannot overwrite the first outcome.
/// </summary>
public sealed class InMemoryCommandRepository(TimeProvider clock) : ICommandRepository
{
    // Keyed by (targetCivId, commandId).
    private readonly Dictionary<(string, string), Command> _byKey = new();
    private readonly Dictionary<string, long> _sequenceByCiv = new(StringComparer.Ordinal);
    private readonly Lock _gate = new();

    private bool IsDeliverable(Command c, DateTimeOffset now) =>
        c.AckStatus is null && !c.Expired && (c.ExpiresAt is null || c.ExpiresAt > now);

    public Task<Command?> GetAsync(string targetCivId, string commandId, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            return Task.FromResult(_byKey.TryGetValue((targetCivId, commandId), out var c) ? InMemoryClone.Copy(c) : null);
        }
    }

    public Task<Command> EnqueueAsync(Command command, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            var key = (command.TargetCivId, command.CommandId);
            if (_byKey.TryGetValue(key, out var existing))
            {
                return Task.FromResult(InMemoryClone.Copy(existing)); // Idempotent enqueue.
            }

            var copy = InMemoryClone.Copy(command);
            var next = _sequenceByCiv.GetValueOrDefault(command.TargetCivId) + 1;
            _sequenceByCiv[command.TargetCivId] = next;
            copy.CommandSequence = next;
            _byKey[key] = copy;
            return Task.FromResult(InMemoryClone.Copy(copy));
        }
    }

    public Task<CommandAckTransition> TryAckAsync(string targetCivId, string commandId, CommandAckStatus status, DateTimeOffset now, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            if (!_byKey.TryGetValue((targetCivId, commandId), out var stored))
            {
                throw new InvalidOperationException($"Command '{commandId}' not found for '{targetCivId}'.");
            }

            if (stored.AckStatus is not null)
            {
                return Task.FromResult(new CommandAckTransition(false, InMemoryClone.Copy(stored)));
            }

            stored.AckStatus = status;
            stored.AckedAt = now;
            stored.Version++;
            return Task.FromResult(new CommandAckTransition(true, InMemoryClone.Copy(stored)));
        }
    }

    public Task MarkAckReconciledAsync(string targetCivId, string commandId, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            if (_byKey.TryGetValue((targetCivId, commandId), out var stored))
            {
                stored.AckReconciled = true;
            }
        }

        return Task.CompletedTask;
    }

    public Task MarkExpiredAsync(string targetCivId, string commandId, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            if (_byKey.TryGetValue((targetCivId, commandId), out var stored) && stored.AckStatus is null)
            {
                stored.Expired = true;
                stored.Version++;
            }
        }

        return Task.CompletedTask;
    }

    public Task<IReadOnlyList<Command>> PullAsync(string targetCivId, long afterSequence, int limit, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var now = clock.GetUtcNow();
        lock (_gate)
        {
            IReadOnlyList<Command> items = _byKey.Values
                .Where(c => c.TargetCivId == targetCivId && IsDeliverable(c, now) && c.CommandSequence > afterSequence)
                .OrderBy(c => c.CommandSequence)
                .Take(limit)
                .Select(InMemoryClone.Copy)
                .ToList();
            return Task.FromResult(items);
        }
    }

    public Task<int> CountPendingAsync(string targetCivId, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var now = clock.GetUtcNow();
        lock (_gate)
        {
            return Task.FromResult(_byKey.Values.Count(c => c.TargetCivId == targetCivId && IsDeliverable(c, now)));
        }
    }

    public Task<IReadOnlyList<Command>> ListExpirableAsync(DateTimeOffset now, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            IReadOnlyList<Command> items = _byKey.Values
                .Where(c => c.AckStatus is null && !c.Expired && c.ExpiresAt is { } e && e <= now)
                .Select(InMemoryClone.Copy)
                .ToList();
            return Task.FromResult(items);
        }
    }

    public Task<IReadOnlyList<Command>> ListUnreconciledAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            IReadOnlyList<Command> items = _byKey.Values
                .Where(c => c.AckStatus is not null && !c.AckReconciled)
                .Select(InMemoryClone.Copy)
                .ToList();
            return Task.FromResult(items);
        }
    }
}
