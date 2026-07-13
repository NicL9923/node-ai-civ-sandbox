using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Common;
using WorldMap.Core.Configuration;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure;

/// <summary>
/// Resolves presented onboarding tokens (by SHA-256 hash) to their preprovisioned bindings. Built
/// once at startup from configuration; the map holds ONLY token hashes. A raw <c>Token</c> in config
/// is hashed immediately at construction and discarded — never persisted, logged, or used as a key.
/// </summary>
public sealed class OnboardingRegistry : IOnboardingRegistry
{
    private readonly Dictionary<string, ResolvedOnboardingRecord> _byHash = new(StringComparer.Ordinal);

    public OnboardingRegistry(IOptions<WorldMapOptions> options, ILogger<OnboardingRegistry> logger)
    {
        foreach (var record in options.Value.Onboarding.Records)
        {
            var hash = !string.IsNullOrWhiteSpace(record.TokenHash)
                ? record.TokenHash.Trim().ToLowerInvariant()
                : !string.IsNullOrWhiteSpace(record.Token)
                    ? Deterministic.Sha256Hex(record.Token)
                    : null;

            if (hash is null || string.IsNullOrEmpty(record.CivId) || string.IsNullOrEmpty(record.SecretRef))
            {
                logger.LogWarning("Skipping an onboarding record missing tokenHash/token, civId or secretRef.");
                continue;
            }

            var keyId = string.IsNullOrEmpty(record.KeyId) ? "key_01" : record.KeyId;
            _byHash[hash] = new ResolvedOnboardingRecord(hash, record.CivId, keyId, record.SecretRef);
        }
    }

    public ResolvedOnboardingRecord? Resolve(string tokenHash) => _byHash.GetValueOrDefault(tokenHash);
}
