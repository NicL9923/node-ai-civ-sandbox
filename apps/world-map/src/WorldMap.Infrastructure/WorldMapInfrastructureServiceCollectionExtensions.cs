using System.Text.Json;
using Azure.Identity;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Configuration;
using WorldMap.Core.Sequencing;
using WorldMap.Infrastructure.Cosmos;
using WorldMap.Infrastructure.InMemory;
using WorldMap.Infrastructure.Secrets;

namespace WorldMap.Infrastructure;

/// <summary>
/// Composition root for the World Infrastructure layer. Selects the storage provider from
/// <c>WorldMap:Storage:Provider</c> and registers the matching repositories, stores, and
/// sequence allocator. All backing services are singletons so in-memory state (and the shared
/// thread-safe <see cref="CosmosClient"/>) persist across scoped requests within the process.
/// </summary>
public static class WorldMapInfrastructureServiceCollectionExtensions
{
    private const string CosmosProvider = "Cosmos";

    public static IServiceCollection AddWorldMapInfrastructure(
        this IServiceCollection services, IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(configuration);

        // Safe to call even if the host also binds WorldMapOptions — binds are additive.
        services.AddOptions<WorldMapOptions>().BindConfiguration(WorldMapOptions.SectionName);

        // The configuration-backed secret resolver is provider-agnostic (secrets are
        // provisioned out-of-band; only references are persisted on credentials).
        services.AddSingleton<ISecretStore, ConfigurationSecretStore>();

        var provider = configuration[$"{WorldMapOptions.SectionName}:Storage:Provider"];
        if (string.Equals(provider, CosmosProvider, StringComparison.OrdinalIgnoreCase))
        {
            AddCosmos(services, configuration);
        }
        else
        {
            AddInMemory(services);
        }

        return services;
    }

    private static void AddInMemory(IServiceCollection services)
    {
        services.AddSingleton<ICivilizationRepository, InMemoryCivilizationRepository>();
        services.AddSingleton<ICivCredentialRepository, InMemoryCivCredentialRepository>();
        services.AddSingleton<IInteractionRepository, InMemoryInteractionRepository>();
        services.AddSingleton<ICommandRepository, InMemoryCommandRepository>();
        services.AddSingleton<IWorldEventRepository, InMemoryWorldEventRepository>();
        services.AddSingleton<IRelationshipRepository, InMemoryRelationshipRepository>();

        services.AddSingleton<INonceStore, InMemoryNonceStore>();
        services.AddSingleton<IIdempotencyStore, InMemoryIdempotencyStore>();
        services.AddSingleton<IOnboardingTokenStore, InMemoryOnboardingTokenStore>();

        services.AddSingleton<ISequenceAllocator, InMemorySequenceAllocator>();
    }

    private static void AddCosmos(IServiceCollection services, IConfiguration configuration)
    {
        var endpoint = configuration[$"{WorldMapOptions.SectionName}:Storage:CosmosEndpoint"];
        if (string.IsNullOrWhiteSpace(endpoint))
        {
            throw new InvalidOperationException(
                "WorldMap:Storage:CosmosEndpoint is required when WorldMap:Storage:Provider is 'Cosmos'.");
        }

        services.AddSingleton(_ =>
        {
            var clientOptions = new CosmosClientOptions
            {
                // System.Text.Json only — never Newtonsoft. Web defaults (camelCase, case-insensitive).
                UseSystemTextJsonSerializerWithOptions = new JsonSerializerOptions(JsonSerializerDefaults.Web),
                ApplicationName = "WorldMap",
            };

            // Managed identity / DefaultAzureCredential — no account keys.
            return new CosmosClient(endpoint, new DefaultAzureCredential(), clientOptions);
        });

        // Provisions the database + containers at startup (idempotent).
        services.AddHostedService<CosmosBootstrapper>();

        services.AddSingleton<ICivilizationRepository, CosmosCivilizationRepository>();
        services.AddSingleton<ICivCredentialRepository, CosmosCivCredentialRepository>();
        services.AddSingleton<IInteractionRepository, CosmosInteractionRepository>();
        services.AddSingleton<ICommandRepository, CosmosCommandRepository>();
        services.AddSingleton<IWorldEventRepository, CosmosWorldEventRepository>();
        services.AddSingleton<IRelationshipRepository, CosmosRelationshipRepository>();

        services.AddSingleton<INonceStore, CosmosNonceStore>();
        services.AddSingleton<IIdempotencyStore, CosmosIdempotencyStore>();
        services.AddSingleton<IOnboardingTokenStore, CosmosOnboardingTokenStore>();

        services.AddSingleton<ISequenceAllocator, CosmosSequenceAllocator>();
    }
}
