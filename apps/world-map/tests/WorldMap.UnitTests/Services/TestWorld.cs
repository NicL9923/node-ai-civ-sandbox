using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;
using WorldMap.Core.Application.Impl;
using WorldMap.Core.Configuration;
using WorldMap.Core.Contracts;
using WorldMap.Core.Domain;
using WorldMap.Infrastructure.InMemory;
using WorldMap.Infrastructure.Secrets;

namespace WorldMap.UnitTests.Services;

internal sealed class TestWorld
{
    public static readonly (string Token, string CivId, string SecretRef, string Secret)[] Records =
    [
        ("token-a", "civ_ra", "ref-a", "secret-a"),
        ("token-b", "civ_rb", "ref-b", "secret-b"),
        ("token-c", "civ_rc", "ref-c", "secret-c"),
        ("token-d", "civ_rd", "ref-d", "secret-d"),
        ("token-e", "civ_re", "ref-e", "secret-e"),
    ];

    public TestWorld()
    {
        Options = Microsoft.Extensions.Options.Options.Create(new WorldMapOptions
        {
            ProtocolVersion = "1.0.0-test",
            WorldBaseUrl = "https://world.test/world/v1",
            Onboarding = new OnboardingOptions
            {
                Records = Records
                    .Select(r => new OnboardingRecord { Token = r.Token, CivId = r.CivId, KeyId = "key_01", SecretRef = r.SecretRef })
                    .ToList(),
            },
            Liveness = new LivenessOptions { SuggestedHeartbeatSeconds = 15 },
            Interaction = new InteractionOptions
            {
                CommandTtlSeconds = 60,
                IdempotencyTtlSeconds = 300,
            },
            Secrets = new SecretsOptions
            {
                Map = Records.ToDictionary(r => r.SecretRef, r => r.Secret, StringComparer.Ordinal),
            },
        });

        Clock = new FakeTimeProvider(new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero));
        OnboardingTokens = new InMemoryOnboardingTokenStore();
        SecretStore = new InMemorySecretStore(Options.Value.Secrets.Map);

        Onboarding = new OnboardingService(
            Civilizations,
            Credentials,
            OnboardingTokens,
            SecretStore,
            Idempotency,
            Sequence,
            Clock,
            Options,
            NullLogger<OnboardingService>.Instance);
        Civilization = new CivilizationService(
            Civilizations,
            Commands,
            Clock,
            Options,
            NullLogger<CivilizationService>.Instance);
        Events = new EventService(
            WorldEvents,
            Idempotency,
            Sequence,
            Clock,
            NullLogger<EventService>.Instance);
        Interactions = new InteractionService(
            Civilizations,
            InteractionRepository,
            Commands,
            WorldEvents,
            Relationships,
            Idempotency,
            Sequence,
            Clock,
            Options,
            NullLogger<InteractionService>.Instance);
        Command = new CommandService(
            Commands,
            InteractionRepository,
            Clock,
            NullLogger<CommandService>.Instance);
        Relationship = new RelationshipService(Relationships);
        Maintenance = new MaintenanceService(
            Commands,
            InteractionRepository,
            Clock,
            NullLogger<MaintenanceService>.Instance);
    }

    public IOptions<WorldMapOptions> Options { get; }
    public FakeTimeProvider Clock { get; }
    public InMemoryCivilizationRepository Civilizations { get; } = new();
    public InMemoryCivCredentialRepository Credentials { get; } = new();
    public InMemoryOnboardingTokenStore OnboardingTokens { get; }
    public InMemorySecretStore SecretStore { get; }
    public InMemoryIdempotencyStore Idempotency { get; } = new();
    public InMemorySequenceAllocator Sequence { get; } = new();
    public InMemoryCommandRepository Commands { get; } = new();
    public InMemoryInteractionRepository InteractionRepository { get; } = new();
    public InMemoryWorldEventRepository WorldEvents { get; } = new();
    public InMemoryRelationshipRepository Relationships { get; } = new();

    public OnboardingService Onboarding { get; }
    public CivilizationService Civilization { get; }
    public EventService Events { get; }
    public InteractionService Interactions { get; }
    public CommandService Command { get; }
    public RelationshipService Relationship { get; }
    public MaintenanceService Maintenance { get; }

    public static CapabilitiesDto Capabilities => new()
    {
        ProtocolVersion = "1.0",
        SupportedInteractionKinds = ["contact", "message"],
    };

    public async Task<Civilization> SeedCivAsync(string civId, long ordinal, string? displayName = null)
    {
        var now = Clock.GetUtcNow();
        var civ = new Civilization
        {
            CivId = civId,
            KeyId = "key_01",
            DisplayName = displayName ?? civId,
            ProtocolVersion = "1.0",
            Capabilities = Capabilities,
            RegisteredAt = now,
            CreatedAt = now,
            UpdatedAt = now,
            Ordinal = ordinal,
        };
        await Civilizations.UpsertAsync(civ, CancellationToken.None);
        return civ;
    }

    public async Task<(string Source, string Target)> SeedCivPairAsync()
    {
        await SeedCivAsync("civ_a", 1, "Aurora");
        await SeedCivAsync("civ_b", 2, "Borealis");
        return ("civ_a", "civ_b");
    }

    public static InteractionRequestDto ContactRequest(
        string source,
        string target,
        string? greeting = "Greetings") => new()
    {
        Kind = "contact",
        Source = source,
        Target = target,
        AuthorityDecision = new AuthorityDecisionDto { Mode = "president" },
        PublicNarrative = "First contact",
        Payload = JsonSerializer.SerializeToNode(new ContactIntentDataDto { Greeting = greeting! }),
    };

    public static InteractionRequestDto MessageRequest(
        string source,
        string target,
        string? body = "Hello") => new()
    {
        Kind = "message",
        Source = source,
        Target = target,
        AuthorityDecision = new AuthorityDecisionDto { Mode = "president" },
        Payload = JsonSerializer.SerializeToNode(new MessageIntentDataDto
        {
            Body = body!,
            Subject = "Trade",
        }),
    };
}
