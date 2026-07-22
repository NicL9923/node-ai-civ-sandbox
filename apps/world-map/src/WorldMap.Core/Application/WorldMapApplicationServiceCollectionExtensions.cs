using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Application.Impl;

namespace WorldMap.Core.Application;

/// <summary>DI registration for the World application services.</summary>
public static class WorldMapApplicationServiceCollectionExtensions
{
    /// <summary>
    /// Registers the application services. Assumes repositories, stores, the sequence
    /// allocator, <see cref="TimeProvider"/> and <c>WorldMapOptions</c> are already
    /// registered (see <c>AddWorldMapInfrastructure</c>).
    /// </summary>
    public static IServiceCollection AddWorldMapApplication(this IServiceCollection services)
    {
        services.AddSingleton<PublicEventFactory>();
        services.AddSingleton<SocialEventFactory>();
        services.TryAddSingleton<IWorldEventSink, NoOpWorldEventSink>();
        services.AddScoped<IdempotencyExecutor>();
        services.AddScoped<SocialRateLimiter>();
        services.AddScoped<SocialMutationPipeline>();
        services.AddScoped<IInteractionProcessor, InteractionProcessor>();

        services.AddScoped<IOnboardingService, OnboardingService>();
        services.AddScoped<ICivilizationService, CivilizationService>();
        services.AddScoped<IEventService, EventService>();
        services.AddScoped<ICommandService, CommandService>();
        services.AddScoped<IInteractionService, InteractionService>();
        services.AddScoped<IRelationshipService, RelationshipService>();
        services.AddScoped<IMaintenanceService, MaintenanceService>();

        services.AddScoped<ISocialAccountService, Impl.SocialAccountService>();
        services.AddScoped<ISocialPostService, Impl.SocialPostService>();
        services.AddScoped<ISocialGraphService, Impl.SocialGraphService>();
        services.AddScoped<ISocialFeedService, Impl.SocialFeedService>();
        return services;
    }
}
