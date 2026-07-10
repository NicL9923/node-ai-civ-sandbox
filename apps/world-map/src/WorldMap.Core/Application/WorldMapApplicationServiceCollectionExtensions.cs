using Microsoft.Extensions.DependencyInjection;
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
        services.AddScoped<IOnboardingService, OnboardingService>();
        services.AddScoped<ICivilizationService, CivilizationService>();
        services.AddScoped<IEventService, EventService>();
        services.AddScoped<ICommandService, CommandService>();
        services.AddScoped<IInteractionService, InteractionService>();
        services.AddScoped<IRelationshipService, RelationshipService>();
        services.AddScoped<IMaintenanceService, MaintenanceService>();
        return services;
    }
}
