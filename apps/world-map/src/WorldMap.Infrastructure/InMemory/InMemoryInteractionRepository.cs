using WorldMap.Core.Abstractions;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.InMemory;

/// <summary>
/// Thread-safe in-memory interaction ledger. <see cref="UpdateAsync"/> is a monotonic-version CAS:
/// a write succeeds only when it advances the stored version, so concurrent processors converge
/// without lost updates.
/// </summary>
public sealed class InMemoryInteractionRepository : IInteractionRepository
{
    private readonly Dictionary<string, Interaction> _byId = new(StringComparer.Ordinal);
    private readonly Lock _gate = new();

    public Task<Interaction?> GetAsync(string interactionId, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            return Task.FromResult(_byId.TryGetValue(interactionId, out var i) ? InMemoryClone.Copy(i) : null);
        }
    }

    public Task AddAsync(Interaction interaction, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            // Idempotent: a resumed acceptance for the same deterministic id keeps the original.
            _ = _byId.TryAdd(interaction.InteractionId, InMemoryClone.Copy(interaction));
        }

        return Task.CompletedTask;
    }

    public Task<bool> UpdateAsync(Interaction interaction, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            if (_byId.TryGetValue(interaction.InteractionId, out var stored) && stored.Version >= interaction.Version)
            {
                return Task.FromResult(false); // Stale write — stored moved on.
            }

            _byId[interaction.InteractionId] = InMemoryClone.Copy(interaction);
            return Task.FromResult(true);
        }
    }

    public Task<IReadOnlyList<Interaction>> ListIncompleteAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            IReadOnlyList<Interaction> items = _byId.Values
                .Where(i => !i.IsProcessingComplete)
                .Select(InMemoryClone.Copy)
                .ToList();
            return Task.FromResult(items);
        }
    }

    public Task<IReadOnlyList<Interaction>> ListExpirableAsync(DateTimeOffset now, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            IReadOnlyList<Interaction> items = _byId.Values
                .Where(i => !i.IsTerminal && i.EffectiveExpiresAt is { } e && e <= now)
                .Select(InMemoryClone.Copy)
                .ToList();
            return Task.FromResult(items);
        }
    }
}
