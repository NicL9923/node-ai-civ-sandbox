using Microsoft.Extensions.Options;
using WorldMap.Core.Configuration;
using WorldMap.Infrastructure.Secrets;

namespace WorldMap.UnitTests.Infrastructure;

public sealed class SecretStoreTests
{
    [Theory]
    [InlineData("")]
    [InlineData("missing")]
    public void InMemory_UnknownOrEmpty_ReturnsNull(string secretRef)
    {
        var store = new InMemorySecretStore(new Dictionary<string, string> { ["known"] = "secret" });
        Assert.Null(store.GetSecret(secretRef));
        Assert.Equal("secret", store.GetSecret("known"));
    }

    [Theory]
    [InlineData("")]
    [InlineData("missing")]
    public void Configuration_UnknownOrEmpty_ReturnsNull(string secretRef)
    {
        var options = Options.Create(new WorldMapOptions
        {
            Secrets = new SecretsOptions { Map = new Dictionary<string, string> { ["known"] = "secret" } },
        });
        var store = new ConfigurationSecretStore(options);
        Assert.Null(store.GetSecret(secretRef));
        Assert.Equal("secret", store.GetSecret("known"));
    }
}
