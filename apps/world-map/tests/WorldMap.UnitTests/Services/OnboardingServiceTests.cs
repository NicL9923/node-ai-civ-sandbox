using Microsoft.Extensions.Logging.Abstractions;
using WorldMap.Core.Application;
using WorldMap.Core.Application.Impl;
using WorldMap.Core.Common;
using WorldMap.Core.Contracts;
using WorldMap.Infrastructure;
using WorldMap.Infrastructure.InMemory;
using WorldMap.UnitTests.Fakes;

namespace WorldMap.UnitTests.Services;

public sealed class OnboardingServiceTests
{
    [Fact]
    public async Task Register_BindsPreprovisionedCivilizationAndReplayIsDuplicate()
    {
        var world = new TestWorld();
        var request = Valid("token-a");

        var first = await world.Onboarding.RegisterAsync(request, "key", default);
        var replay = await world.Onboarding.RegisterAsync(request, "key", default);

        Assert.True(first.IsSuccess);
        Assert.Equal("civ_ra", first.Value.Body.CivId);
        Assert.False(first.Value.Body.Duplicate);
        Assert.True(replay.Value.Body.Duplicate);
        Assert.Equal(first.Value.Location, replay.Value.Location);
        Assert.NotNull(await world.Civilizations.GetAsync("civ_ra", default));
        var credential = await world.Credentials.GetAsync("civ_ra", default);
        Assert.Equal("ref-a", credential!.SecretRef);
    }

    [Fact]
    public async Task Register_UnknownTokenReturnsRegistrationConflict()
    {
        var result = await new TestWorld().Onboarding.RegisterAsync(Valid("unknown"), "key", default);

        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.RegistrationConflict, result.Error.Code);
    }

    [Fact]
    public async Task Register_FailureAfterReservationCanResumeWithSameKey()
    {
        var world = new TestWorld();
        var registry = new OnboardingRegistry(world.Options, NullLogger<OnboardingRegistry>.Instance);
        var reservingStore = new ThrowOnceAfterTokenReserve(world.OnboardingTokens);
        var service = new OnboardingService(
            world.Civilizations, world.Credentials, registry, reservingStore, world.SecretStore,
            world.Idempotency, world.Clock, world.Options, NullLogger<OnboardingService>.Instance);

        await Assert.ThrowsAsync<InjectedFailureException>(
            () => service.RegisterAsync(Valid("token-a"), "resume", default));
        Assert.Null(await world.Civilizations.GetAsync("civ_ra", default));

        world.Clock.Advance(TimeSpan.FromSeconds(6));
        var retry = await service.RegisterAsync(Valid("token-a"), "resume", default);

        Assert.True(retry.IsSuccess);
        Assert.Equal("civ_ra", retry.Value.Body.CivId);
        Assert.Single(await world.Civilizations.ListAllAsync(default));
    }

    [Fact]
    public async Task Register_ConcurrentDifferentKeysForSameTokenConvergeOnOneCivilization()
    {
        var world = new TestWorld();
        var results = await Task.WhenAll(Enumerable.Range(0, 20)
            .Select(i => world.Onboarding.RegisterAsync(Valid("token-a"), $"key-{i}", default)));

        Assert.All(results, result =>
        {
            Assert.True(result.IsSuccess);
            Assert.Equal("civ_ra", result.Value.Body.CivId);
        });
        Assert.Single(await world.Civilizations.ListAllAsync(default));
    }

    [Theory]
    [InlineData(null, "Aurora")]
    [InlineData("token-a", null)]
    public async Task Register_RequiredFieldsAreValidated(string? token, string? displayName)
    {
        var result = await new TestWorld().Onboarding.RegisterAsync(
            new RegistrationRequestDto
            {
                OnboardingToken = token,
                DisplayName = displayName,
                Capabilities = TestWorld.Capabilities,
            },
            "key",
            default);

        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.ValidationFailed, result.Error.Code);
    }

    private static RegistrationRequestDto Valid(string token) => new()
    {
        OnboardingToken = token,
        DisplayName = "Aurora",
        Capabilities = TestWorld.Capabilities,
    };
}
