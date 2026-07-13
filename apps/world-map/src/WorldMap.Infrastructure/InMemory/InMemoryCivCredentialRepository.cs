using System.Collections.Concurrent;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.InMemory;

/// <summary>Thread-safe in-memory S2S credential store keyed by <c>civId</c>.</summary>
public sealed class InMemoryCivCredentialRepository : ICivCredentialRepository
{
    private readonly ConcurrentDictionary<string, CivCredential> _byCivId = new(StringComparer.Ordinal);

    public Task<CivCredential?> GetAsync(string civId, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        return Task.FromResult(_byCivId.TryGetValue(civId, out var cred) ? cred : null);
    }

    public Task UpsertAsync(CivCredential credential, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        _byCivId[credential.CivId] = credential;
        return Task.CompletedTask;
    }
}
