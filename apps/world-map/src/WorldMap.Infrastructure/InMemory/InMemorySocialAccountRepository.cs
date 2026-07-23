using WorldMap.Core.Abstractions;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.InMemory;

/// <summary>
/// Thread-safe in-memory canonical account store keyed by the deterministic account id.
/// <see cref="UpsertAsync"/> is create-or-replace (canonical sync write); <see cref="TryUpdateAsync"/>
/// is a monotonic-version CAS for eventually-consistent count projections.
/// </summary>
public sealed class InMemorySocialAccountRepository : ISocialAccountRepository
{
    private readonly Dictionary<string, SocialAccount> _byId = new(StringComparer.Ordinal);
    private readonly Lock _gate = new();

    public Task<SocialAccount?> GetAsync(string accountId, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            return Task.FromResult(_byId.TryGetValue(accountId, out var a) ? InMemoryClone.Copy(a) : null);
        }
    }

    public Task UpsertAsync(SocialAccount account, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            _byId[account.AccountId] = InMemoryClone.Copy(account);
            return Task.CompletedTask;
        }
    }

    public Task<bool> TryUpdateAsync(SocialAccount account, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            if (!_byId.TryGetValue(account.AccountId, out var stored) || stored.Version >= account.Version)
            {
                return Task.FromResult(false);
            }

            _byId[account.AccountId] = InMemoryClone.Copy(account);
            return Task.FromResult(true);
        }
    }

    public Task<SocialListPage<SocialAccount>> ListPageAsync(string? continuation, int limit, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            var items = _byId.Values
                .Where(a => continuation is null || string.CompareOrdinal(a.AccountId, continuation) > 0)
                .OrderBy(a => a.AccountId, StringComparer.Ordinal)
                .Take(limit)
                .Select(InMemoryClone.Copy)
                .ToList();

            var next = items.Count == limit && items.Count > 0 ? items[^1].AccountId : null;
            return Task.FromResult(new SocialListPage<SocialAccount>(items, next));
        }
    }
}
