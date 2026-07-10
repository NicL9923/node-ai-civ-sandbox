using System.Text.Json;
using Azure.Identity;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.DependencyInjection;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Configuration;
using WorldMap.Infrastructure.Cosmos;
using WorldMap.Infrastructure.InMemory;
using WorldMap.Infrastructure.Secrets;

namespace WorldMap.Infrastructure;

/// <summary>
/// Composition root for the World Infrastructure layer. Validates the storage provider against an
/// explicit allowlist and registers the matching repositories, stores, readiness probe, and (for
/// Cosmos, only when bootstrap is enabled) the provisioning bootstrapper. Backing services are
/// singletons so in-memory state and the thread-safe <see cref="CosmosClient"/> persist across
/// scoped requests within the process.
/// </summary>
public static class WorldMapInfrastructureServiceCollectionExtensions
{
    public static IServiceCollection AddWorldMapInfrastructure(
        this IServiceCollection services,
        WorldMapOptions options,
        bool isDevelopment)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(options);

        if (!Enum.TryParse<StorageProvider>(options.Storage.Provider, ignoreCase: true, out var provider))
        {
            throw new InvalidOperationException(
                $"WorldMap:Storage:Provider '{options.Storage.Provider}' is invalid. Allowed values: {string.Join(", ", Enum.GetNames<StorageProvider>())}.");
        }

        // Shared, provider-agnostic services: the config-backed secret resolver and the hash-only
        // onboarding registry (secrets are provisioned out-of-band; only references are persisted).
        services.AddSingleton<ISecretStore, ConfigurationSecretStore>();
        services.AddSingleton<IOnboardingRegistry, OnboardingRegistry>();

        switch (provider)
        {
            case StorageProvider.InMemory:
                if (!isDevelopment && !options.Storage.AllowInMemoryOutsideDevelopment)
                {
                    throw new InvalidOperationException(
                        "The InMemory storage provider is not durable and is blocked outside Development. " +
                        "Use Cosmos, or set WorldMap:Storage:AllowInMemoryOutsideDevelopment=true only for an explicit dev/test scenario.");
                }

                AddInMemory(services);
                break;

            case StorageProvider.Cosmos:
                AddCosmos(services, options);
                break;
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
        services.AddSingleton<IReadinessProbe, InMemoryReadinessProbe>();
    }

    private static void AddCosmos(IServiceCollection services, WorldMapOptions options)
    {
        if (string.IsNullOrWhiteSpace(options.Storage.CosmosEndpoint))
        {
            throw new InvalidOperationException(
                "WorldMap:Storage:CosmosEndpoint is required when WorldMap:Storage:Provider is 'Cosmos'.");
        }

        var endpoint = options.Storage.CosmosEndpoint;
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

        // Container creation is gated: only provision when explicitly enabled. Normal runtime relies
        // on the readiness probe to validate that required containers exist.
        if (options.Storage.BootstrapEnabled)
        {
            services.AddHostedService<CosmosBootstrapper>();
        }

        services.AddSingleton<ICivilizationRepository, CosmosCivilizationRepository>();
        services.AddSingleton<ICivCredentialRepository, CosmosCivCredentialRepository>();
        services.AddSingleton<IInteractionRepository, CosmosInteractionRepository>();
        services.AddSingleton<ICommandRepository, CosmosCommandRepository>();
        services.AddSingleton<IWorldEventRepository, CosmosWorldEventRepository>();
        services.AddSingleton<IRelationshipRepository, CosmosRelationshipRepository>();

        services.AddSingleton<INonceStore, CosmosNonceStore>();
        services.AddSingleton<IIdempotencyStore, CosmosIdempotencyStore>();
        services.AddSingleton<IOnboardingTokenStore, CosmosOnboardingTokenStore>();
        services.AddSingleton<IReadinessProbe, CosmosReadinessProbe>();
    }
}
