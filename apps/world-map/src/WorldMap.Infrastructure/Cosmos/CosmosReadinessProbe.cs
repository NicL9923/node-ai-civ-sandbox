using System.Net;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Configuration;

namespace WorldMap.Infrastructure.Cosmos;

/// <summary>
/// Readiness probe for the Cosmos provider. Validates that the database and every required container
/// exist AND that each container's schema matches the runtime's assumptions (uniform '/pk' partition
/// key, and time-to-live enabled on the nonce/idempotency containers), so the readiness endpoint fails
/// non-200 during an outage or a missing/incomplete/misconfigured schema.
///
/// <para>It is strictly READ-ONLY — it never creates the database or any container (provisioning is
/// the opt-in <see cref="CosmosBootstrapper"/>'s job). Any Cosmos error is reported as
/// <c>Ready=false</c> with a detail rather than thrown.</para>
/// </summary>
public sealed class CosmosReadinessProbe(CosmosClient client, IOptions<WorldMapOptions> options, WriterLeaseState leaseState) : IReadinessProbe
{
    private readonly string _databaseName = options.Value.Storage.DatabaseName;

    public async Task<ReadinessResult> CheckAsync(CancellationToken ct)
    {
        var database = client.GetDatabase(_databaseName);

        try
        {
            await database.ReadAsync(cancellationToken: ct).ConfigureAwait(false);
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            return new ReadinessResult(false, $"Cosmos database '{_databaseName}' does not exist.");
        }
        catch (CosmosException ex)
        {
            return new ReadinessResult(false, $"Cosmos database '{_databaseName}' unavailable: {ex.StatusCode}.");
        }

        var missing = new List<string>();
        foreach (var name in CosmosContainers.All)
        {
            ContainerProperties properties;
            try
            {
                var response = await database.GetContainer(name).ReadContainerAsync(cancellationToken: ct).ConfigureAwait(false);
                properties = response.Resource;
            }
            catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
            {
                missing.Add(name);
                continue;
            }
            catch (CosmosException ex)
            {
                return new ReadinessResult(false, $"Cosmos container '{name}' unavailable: {ex.StatusCode}.");
            }

            // The schema must match what the runtime assumes: a uniform '/pk' partition key, and a
            // safe time-to-live posture per the container's role.
            if (properties.PartitionKeyPath != CosmosContainers.PartitionKeyPath)
            {
                return new ReadinessResult(false,
                    $"Cosmos container '{name}' has partition key '{properties.PartitionKeyPath}', expected '{CosmosContainers.PartitionKeyPath}'.");
            }

            if (CosmosContainers.TtlContainers.Contains(name))
            {
                // Ephemeral containers (nonce/idempotency) rely on per-item TTL to self-purge — it must be enabled.
                if (properties.DefaultTimeToLive is null or 0)
                {
                    return new ReadinessResult(false, $"Cosmos container '{name}' requires time-to-live to be enabled.");
                }
            }
            else
            {
                // Durable containers must NOT carry a positive default TTL, which would silently delete data.
                // Absent (null) or -1 (on, no blanket default) is required.
                if (properties.DefaultTimeToLive is > 0)
                {
                    return new ReadinessResult(false,
                        $"Cosmos container '{name}' has a destructive positive default time-to-live ({properties.DefaultTimeToLive}s); durable containers must have none or -1.");
                }
            }
        }

        if (missing.Count > 0)
        {
            return new ReadinessResult(false, $"Cosmos containers missing: {string.Join(", ", missing)}.");
        }

        // Fail closed: an instance that does not hold the single-writer lease must not be routed
        // mutation traffic. (When the lease is disabled, the state is initialized held.)
        if (!leaseState.IsHeld)
        {
            return new ReadinessResult(false, "This instance does not hold the single-writer lease.");
        }

        return new ReadinessResult(true, $"Cosmos database '{_databaseName}' and containers ready.");
    }
}
