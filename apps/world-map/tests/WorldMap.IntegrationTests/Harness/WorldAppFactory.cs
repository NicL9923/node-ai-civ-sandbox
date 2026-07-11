using System.Collections.Concurrent;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Application;
using WorldMap.Core.Contracts;

namespace WorldMap.IntegrationTests.Harness;

/// <summary>
/// A <see cref="WebApplicationFactory{TEntryPoint}"/> for the World runtime configured for
/// deterministic, self-contained integration tests: in-memory storage, a fixed
/// <c>WorldBaseUrl</c>, a pool of operator-preprovisioned onboarding records (token -&gt;
/// civId/keyId/secretRef) and matching secrets in the configuration-backed secret store.
///
/// Each factory instance owns its own process-scoped singleton state (repositories, stores,
/// sequence allocator), so a fresh factory per test class gives full isolation. Signing
/// secrets are retrieved out-of-band via <see cref="GetSigningSecretAsync"/> — the runtime
/// resolves them through <c>ISecretStore</c>, never over HTTP.
/// </summary>
public sealed class WorldAppFactory : WebApplicationFactory<Program>
{
    /// <summary>The known onboarding token for record 0 (reserved for the explicit registration test).</summary>
    public const string PrimaryOnboardingToken = "onb-test-token-0";

    /// <summary>Deterministic base URL returned to civs and used to build Location headers.</summary>
    public const string WorldBaseUrl = "https://world.test/world/v1";

    private const int TokenPoolSize = 128;
    private readonly AdjustableTimeProvider? _clock;

    // Auto-registration draws from records 1..N; record 0 is reserved for the explicit
    // registration test so the two never collide.
    private readonly ConcurrentQueue<string> _autoTokens = new();

    public WorldAppFactory(bool useControllableTime = false)
    {
        if (useControllableTime)
        {
            _clock = new AdjustableTimeProvider(DateTimeOffset.UtcNow);
        }

        for (var i = 1; i < TokenPoolSize; i++)
        {
            _autoTokens.Enqueue(TokenAt(i));
        }
    }

    private static string TokenAt(int i) => $"onb-test-token-{i}";

    private static string CivIdAt(int i) => $"civ_t{i}";

    /// <summary>The fixed, preprovisioned civId that a given onboarding token resolves to.</summary>
    public static string CivIdForToken(string token)
    {
        // Records are provisioned as token "onb-test-token-{i}" -> civId "civ_t{i}".
        var dash = token.LastIndexOf('-');
        if (dash >= 0 && int.TryParse(token[(dash + 1)..], out var i))
        {
            return CivIdAt(i);
        }

        throw new ArgumentException($"'{token}' is not a harness-provisioned onboarding token.", nameof(token));
    }

    /// <summary>The fixed civId bound to <see cref="PrimaryOnboardingToken"/> (record 0).</summary>
    public static string PrimaryCivId => CivIdAt(0);

    private static string SecretRefAt(int i) => $"ref-{i}";

    private static string SecretAt(int i) => $"test-secret-{i}";

    /// <summary>Hands out the next unused onboarding token for auto-registration helpers.</summary>
    public string NextOnboardingToken() =>
        _autoTokens.TryDequeue(out var token)
            ? token
            : throw new InvalidOperationException("Onboarding token pool exhausted; raise TokenPoolSize.");

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseSetting("WorldMap:Storage:Provider", "InMemory");

        if (_clock is not null)
        {
            builder.ConfigureServices(services =>
            {
                services.RemoveAll<TimeProvider>();
                services.AddSingleton<TimeProvider>(_clock);
            });
        }

        builder.ConfigureAppConfiguration((_, config) =>
        {
            var settings = new Dictionary<string, string?>
            {
                ["WorldMap:Storage:Provider"] = "InMemory",
                ["WorldMap:WorldBaseUrl"] = WorldBaseUrl,
                // Quiet the maintenance sweeper so it never interferes with short tests.
                ["WorldMap:Maintenance:Enabled"] = "false",
                ["WorldMap:Maintenance:SweepIntervalSeconds"] = "3600",
            };

            // Preprovision onboarding records (token -> civId/keyId/secretRef) and their secrets.
            for (var i = 0; i < TokenPoolSize; i++)
            {
                settings[$"WorldMap:Onboarding:Records:{i}:Token"] = TokenAt(i);
                settings[$"WorldMap:Onboarding:Records:{i}:CivId"] = $"civ_t{i}";
                settings[$"WorldMap:Onboarding:Records:{i}:KeyId"] = "key_01";
                settings[$"WorldMap:Onboarding:Records:{i}:SecretRef"] = SecretRefAt(i);
                settings[$"WorldMap:Secrets:Map:{SecretRefAt(i)}"] = SecretAt(i);
            }

            config.AddInMemoryCollection(settings);
        });
    }

    public DateTimeOffset UtcNow => _clock?.GetUtcNow() ?? DateTimeOffset.UtcNow;

    public async Task AdvanceTimeAndSweepAsync(TimeSpan amount, CancellationToken ct = default)
    {
        if (_clock is null)
        {
            throw new InvalidOperationException("This factory was not configured with controllable time.");
        }

        _clock.Advance(amount);
        using var scope = Services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<IMaintenanceService>().SweepAsync(ct);
    }

    /// <summary>
    /// Retrieves a civ's PLAINTEXT HMAC signing secret out-of-band by resolving its credential
    /// reference and asking the secret store — the same path the runtime uses to verify
    /// signatures. The registration response deliberately never returns the secret.
    /// </summary>
    public async Task<string> GetSigningSecretAsync(string civId, CancellationToken ct = default)
    {
        using var scope = Services.CreateScope();
        var credentials = scope.ServiceProvider.GetRequiredService<ICivCredentialRepository>();
        var secretStore = scope.ServiceProvider.GetRequiredService<ISecretStore>();

        var credential = await credentials.GetAsync(civId, ct)
            ?? throw new InvalidOperationException($"No credential found for civ '{civId}'.");

        return secretStore.GetSecret(credential.SecretRef)
            ?? throw new InvalidOperationException($"No secret provisioned for ref '{credential.SecretRef}'.");
    }

    /// <summary>
    /// Registers a civilization over HTTP and returns everything a test needs to sign as it:
    /// its id, key id, and the out-of-band-retrieved plaintext secret.
    /// </summary>
    public async Task<CivContext> RegisterCivAsync(
        HttpClient client,
        string displayName,
        string? onboardingToken = null,
        CancellationToken ct = default)
    {
        var token = onboardingToken ?? NextOnboardingToken();
        var request = TestDtos.Registration(token, displayName);

        using var message = new HttpRequestMessage(HttpMethod.Post, "/world/v1/civilizations/register")
        {
            Content = JsonContent.Create(request, options: WorldMapJson.Options),
        };
        message.Headers.TryAddWithoutValidation("Idempotency-Key", Guid.NewGuid().ToString("N"));

        using var response = await client.SendAsync(message, ct);
        if (!response.IsSuccessStatusCode)
        {
            var problem = await response.Content.ReadAsStringAsync(ct);
            throw new InvalidOperationException($"Registration failed ({(int)response.StatusCode}): {problem}");
        }

        var body = await response.Content.ReadFromJsonAsync<RegistrationResponseDto>(WorldMapJson.Options, ct)
            ?? throw new InvalidOperationException("Registration returned an empty body.");

        var secret = await GetSigningSecretAsync(body.CivId, ct);
        return new CivContext(body.CivId, body.KeyId, secret);
    }
}

internal sealed class AdjustableTimeProvider(DateTimeOffset initialUtcNow) : TimeProvider
{
    private DateTimeOffset _utcNow = initialUtcNow;

    public override DateTimeOffset GetUtcNow() => _utcNow;

    public void Advance(TimeSpan amount) => _utcNow += amount;
}

/// <summary>A registered civ plus the credentials a test needs to sign requests as it.</summary>
public sealed record CivContext(string CivId, string KeyId, string Secret);
