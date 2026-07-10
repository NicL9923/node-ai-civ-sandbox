using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using WorldMap.Core.Configuration;

namespace WorldMap.Infrastructure.Cosmos;

/// <summary>
/// Idempotently provisions the <c>worldmap</c> database and its containers at startup. All
/// containers share the <c>/pk</c> partition-key path; the nonce and idempotency containers
/// enable time-to-live so expired entries self-purge. Default (index-everything) indexing is
/// left in place — adequate for the MVP query shapes.
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
            _databaseName, cancellationToken: cancellationToken)).Database;

        // Standard containers (no TTL).
        await EnsureContainerAsync(database, CosmosContainers.Civilizations, cancellationToken);
        await EnsureContainerAsync(database, CosmosContainers.Credentials, cancellationToken);
        await EnsureContainerAsync(database, CosmosContainers.Interactions, cancellationToken);
        await EnsureContainerAsync(database, CosmosContainers.Commands, cancellationToken);
        await EnsureContainerAsync(database, CosmosContainers.WorldEvents, cancellationToken);
        await EnsureContainerAsync(database, CosmosContainers.Relationships, cancellationToken);
        await EnsureContainerAsync(database, CosmosContainers.Onboarding, cancellationToken);
        await EnsureContainerAsync(database, CosmosContainers.Sequences, cancellationToken);

        // TTL-enabled containers: DefaultTimeToLive = -1 turns on TTL without a blanket default,
        // so only items that set their own `ttl` expire.
        await EnsureContainerAsync(database, CosmosContainers.Nonces, cancellationToken, timeToLive: -1);
        await EnsureContainerAsync(database, CosmosContainers.Idempotency, cancellationToken, timeToLive: -1);

        logger.LogInformation("Cosmos provisioning complete for database '{Database}'.", _databaseName);
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    private static async Task EnsureContainerAsync(
        Database database, string name, CancellationToken ct, int? timeToLive = null)
    {
        var properties = new ContainerProperties(name, CosmosContainers.PartitionKeyPath);
        if (timeToLive is { } ttl)
        {
            properties.DefaultTimeToLive = ttl;
        }

        await database.CreateContainerIfNotExistsAsync(properties, cancellationToken: ct);
    }
}
