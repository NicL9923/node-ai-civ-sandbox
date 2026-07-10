using WorldMap.Core.Common;
using WorldMap.Core.Contracts;

namespace WorldMap.UnitTests.Services;

public sealed class OnboardingServiceTests
{
    [Fact]
    public async Task RegisterAsync_ValidRequest_StoresCivilizationAndCredential()
    {
        var world = new TestWorld();
        var request = ValidRequest("token-a");

        var result = await world.Onboarding.RegisterAsync(request, "register-1", CancellationToken.None);

        Assert.True(result.IsSuccess);
        Assert.False(result.Value.Body.Duplicate);
        Assert.Equal($"https://world.test/world/v1/civilizations/{result.Value.Body.CivId}", result.Value.Location);
        Assert.NotNull(await world.Civilizations.GetAsync(result.Value.Body.CivId, CancellationToken.None));
        var credential = await world.Credentials.GetAsync(result.Value.Body.CivId, CancellationToken.None);
        Assert.NotNull(credential);
        Assert.Equal("civ_ra", credential.CivId);
        Assert.Equal("ref-a", credential.SecretRef);
        // The runtime persists only a reference — never secret material.
        Assert.Equal("secret-a", world.SecretStore.GetSecret(credential.SecretRef));
    }

    [Fact]
    public async Task RegisterAsync_SameIdempotencyKey_ReturnsDuplicateOriginal()
    {
        var world = new TestWorld();
        var request = ValidRequest("token-a");

        var first = await world.Onboarding.RegisterAsync(request, "same-key", CancellationToken.None);
        var replay = await world.Onboarding.RegisterAsync(request, "same-key", CancellationToken.None);

        Assert.True(first.IsSuccess);
        Assert.True(replay.IsSuccess);
        Assert.False(first.Value.Body.Duplicate);
        Assert.True(replay.Value.Body.Duplicate);
        Assert.Equal(first.Value.Body.CivId, replay.Value.Body.CivId);
        Assert.Equal(first.Value.Location, replay.Value.Location);
    }

    [Fact]
    public async Task RegisterAsync_InvalidToken_ReturnsRegistrationConflict()
    {
        var world = new TestWorld();

        var result = await world.Onboarding.RegisterAsync(
            ValidRequest("not-configured"),
            "register-invalid",
            CancellationToken.None);

        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.RegistrationConflict, result.Error.Code);
    }

    [Fact]
    public async Task RegisterAsync_UsedTokenWithDifferentKey_ReturnsRegistrationConflict()
    {
        var world = new TestWorld();
        await world.Onboarding.RegisterAsync(ValidRequest("token-a"), "register-1", CancellationToken.None);

        var result = await world.Onboarding.RegisterAsync(
            ValidRequest("token-a"),
            "register-2",
            CancellationToken.None);

        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.RegistrationConflict, result.Error.Code);
    }

    [Theory]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task RegisterAsync_MissingDisplayNameOrCapabilities_ReturnsValidationFailed(
        bool missingDisplayName,
        bool missingCapabilities)
    {
        var world = new TestWorld();
        var request = new RegistrationRequestDto
        {
            OnboardingToken = "token-a",
            DisplayName = missingDisplayName ? null : "Aurora",
            Capabilities = missingCapabilities ? null : TestWorld.Capabilities,
        };

        var result = await world.Onboarding.RegisterAsync(request, "invalid", CancellationToken.None);

        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.ValidationFailed, result.Error.Code);
    }

    private static RegistrationRequestDto ValidRequest(string token) => new()
    {
        OnboardingToken = token,
        DisplayName = "Aurora",
        Capabilities = TestWorld.Capabilities,
    };
}
