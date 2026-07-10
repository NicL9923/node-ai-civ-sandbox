using System.Collections.Concurrent;
using WorldMap.Core.Abstractions;

namespace WorldMap.Infrastructure.Secrets;

/// <summary>
/// In-memory secret resolver for tests and local scenarios that inject known secrets through
/// DI (never over HTTP). Holds a process-local reference -&gt; plaintext map. Not for production.
/// </summary>
public sealed class InMemorySecretStore : ISecretStore
{
    private readonly ConcurrentDictionary<string, string> _secrets;

    public InMemorySecretStore()
        => _secrets = new ConcurrentDictionary<string, string>(StringComparer.Ordinal);

    public InMemorySecretStore(IReadOnlyDictionary<string, string> seed)
        => _secrets = new ConcurrentDictionary<string, string>(seed, StringComparer.Ordinal);

    /// <summary>Provisions (or replaces) a secret for a reference.</summary>
    public void Set(string secretRef, string secret) => _secrets[secretRef] = secret;

    public string? GetSecret(string secretRef)
    {
        if (string.IsNullOrEmpty(secretRef))
        {
            return null;
        }

        return _secrets.TryGetValue(secretRef, out var secret) ? secret : null;
    }
}
