using System.Collections.Concurrent;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.InMemory;

/// <summary>Thread-safe in-memory interaction ledger keyed by <c>interactionId</c>.</summary>
public sealed class InMemoryInteractionRepository : IInteractionRepository
{
    private readonly ConcurrentDictionary<string, Interaction> _byId = new(StringComparer.Ordinal);

    public Task<Interaction?> GetAsync(string interactionId, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        return Task.FromResult(_byId.TryGetValue(interactionId, out var interaction) ? interaction : null);
    }

    public Task AddAsync(Interaction interaction, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        _byId[interaction.InteractionId] = interaction;
        return Task.CompletedTask;
    }

    public Task UpdateAsync(Interaction interaction, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        _byId[interaction.InteractionId] = interaction;
        return Task.CompletedTask;
    }

    public Task<IReadOnlyList<Interaction>> ListExpirableAsync(DateTimeOffset now, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var expirable = _byId.Values
            .Where(i => !i.IsTerminal && i.ExpiresAt is { } exp && exp <= now)
            .ToList();
        return Task.FromResult<IReadOnlyList<Interaction>>(expirable);
    }
}
