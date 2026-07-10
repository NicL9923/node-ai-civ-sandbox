using System.Collections.Concurrent;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.InMemory;

/// <summary>
/// Thread-safe in-memory per-civ command queue keyed by <c>(targetCivId, commandId)</c>.
/// Pulls use a forward-only cursor over the per-civ <c>CommandSequence</c>.
/// </summary>
public sealed class InMemoryCommandRepository : ICommandRepository
{
    private readonly ConcurrentDictionary<string, Command> _byKey = new(StringComparer.Ordinal);

    private static string Key(string targetCivId, string commandId) => $"{targetCivId}|{commandId}";

    public Task<Command?> GetAsync(string targetCivId, string commandId, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        return Task.FromResult(_byKey.TryGetValue(Key(targetCivId, commandId), out var cmd) ? cmd : null);
    }

    public Task AddAsync(Command command, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        _byKey[Key(command.TargetCivId, command.CommandId)] = command;
        return Task.CompletedTask;
    }

    public Task UpdateAsync(Command command, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        _byKey[Key(command.TargetCivId, command.CommandId)] = command;
        return Task.CompletedTask;
    }

    public Task<IReadOnlyList<Command>> PullAsync(string targetCivId, long afterSequence, int limit, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var items = _byKey.Values
            .Where(c => c.TargetCivId == targetCivId && c.CommandSequence > afterSequence && !c.Expired)
            .OrderBy(c => c.CommandSequence)
            .Take(limit)
            .ToList();
        return Task.FromResult<IReadOnlyList<Command>>(items);
    }

    public Task<int> CountPendingAsync(string targetCivId, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var count = _byKey.Values
            .Count(c => c.TargetCivId == targetCivId && c.AckStatus is null && !c.Expired);
        return Task.FromResult(count);
    }

    public Task<IReadOnlyList<Command>> ListExpirableAsync(DateTimeOffset now, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var expirable = _byKey.Values
            .Where(c => c.AckStatus is null && !c.Expired && c.ExpiresAt is { } exp && exp <= now)
            .ToList();
        return Task.FromResult<IReadOnlyList<Command>>(expirable);
    }
}
