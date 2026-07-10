using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Configuration;

namespace WorldMap.Infrastructure.Secrets;

/// <summary>
/// Configuration-backed secret resolver. Reads S2S HMAC secrets from the bound
/// <see cref="WorldMapOptions.Secrets"/> <c>Map</c> (reference -&gt; secret). In production
/// these entries are App Service settings backed by Key Vault references; locally they may be
/// supplied via appsettings / user-secrets / environment variables. Secrets are provisioned
/// out-of-band — this store only resolves them, never mints or persists them.
/// </summary>
public sealed class ConfigurationSecretStore(IOptions<WorldMapOptions> options) : ISecretStore
{
    private readonly WorldMapOptions _options = options.Value;

    public string? GetSecret(string secretRef)
    {
        if (string.IsNullOrEmpty(secretRef))
        {
            return null;
        }

        return _options.Secrets.Map.TryGetValue(secretRef, out var secret) ? secret : null;
    }
}
