using Microsoft.Extensions.Options;
using WorldMap.Core.Configuration;
using WorldMap.Infrastructure.Secrets;

namespace WorldMap.UnitTests.Infrastructure;

/// <summary>
/// Verifies the secret RESOLVERS (config-backed + in-memory). Secrets are provisioned
/// out-of-band and only referenced — there is no minting/encryption path to test.
/// </summary>
public sealed class SecretStoreTests
{
    [Fact]
    public void ConfigurationSecretStore_ResolvesConfiguredSecret_ElseNull()
    {
        var options = Options.Create(new WorldMapOptions
        {
            Secrets = new SecretsOptions { Map = { ["aurora-hmac-v1"] = "the-secret" } },
        });
        var store = new ConfigurationSecretStore(options);

        Assert.Equal("the-secret", store.GetSecret("aurora-hmac-v1"));
        Assert.Null(store.GetSecret("unknown-ref"));
        Assert.Null(store.GetSecret(string.Empty));
    }

    [Fact]
    public void InMemorySecretStore_SeedAndSet_Resolve()
    {
        var store = new InMemorySecretStore(new Dictionary<string, string> { ["ref-1"] = "s1" });
        Assert.Equal("s1", store.GetSecret("ref-1"));
        Assert.Null(store.GetSecret("ref-2"));

        store.Set("ref-2", "s2");
        Assert.Equal("s2", store.GetSecret("ref-2"));

        // Overwrite is allowed (re-provisioning).
        store.Set("ref-1", "s1b");
        Assert.Equal("s1b", store.GetSecret("ref-1"));
    }
}
