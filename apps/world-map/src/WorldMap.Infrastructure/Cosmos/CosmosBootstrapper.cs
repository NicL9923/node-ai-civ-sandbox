using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using WorldMap.Core.Configuration;

namespace WorldMap.Infrastructure.Cosmos;

/// <summary>
/// Opt-in Cosmos provisioner. Only registered when <c>WorldMap:Storage:BootstrapEnabled</c> is true;
/// normal runtime relies on <see cref="CosmosReadinessProbe"/> to validate the schema instead of
/// creating it. Idempotently creates the database and every required container (all sharing the
/// <c>/pk</c> partition-key path). The nonce and idempotency containers enable time-to-live so
/// expired entries self-purge. Default (index-everything) indexing is adequate for the MVP queries.
/// </summary>
public sealed class CosmosBootstrapper(
    CosmosClient client,
    IOptions<WorldMapOptions> options,
    ILogger<CosmosBootstrapper> logger) : IHostedService
{
    private readonly string _databaseName = options.Value.Storage.DatabaseName;

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        logger.LogInformation("Ensuring Cosmos database '{Database}' and containers exist.", _databaseName);

        var database = (await client.CreateDatabaseIfNotExistsAsync(
            _databaseName, cancellationToken: cancellationToken).ConfigureAwait(false)).Database;

        foreach (var name in CosmosContainers.All)
        {
            var ttl = CosmosContainers.TtlContainers.Contains(name) ? -1 : (int?)null;
            await EnsureContainerAsync(database, name, cancellationToken, ttl).ConfigureAwait(false);
        }

        logger.LogInformation("Cosmos provisioning complete for database '{Database}'.", _databaseName);
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    private static async Task EnsureContainerAsync(
        Database database, string name, CancellationToken ct, int? timeToLive = null)
    {
        // DefaultTimeToLive = -1 turns TTL on without a blanket default, so only items that set their
        // own `ttl` expire.
        var properties = new ContainerProperties(name, CosmosContainers.PartitionKeyPath);
        if (timeToLive is { } ttl)
        {
            properties.DefaultTimeToLive = ttl;
        }

        await database.CreateContainerIfNotExistsAsync(properties, cancellationToken: ct).ConfigureAwait(false);
    }
}
