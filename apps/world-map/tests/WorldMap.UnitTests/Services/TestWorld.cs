using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Application;
using WorldMap.Core.Application.Impl;
using WorldMap.Core.Configuration;
using WorldMap.Core.Contracts;
using WorldMap.Core.Domain;
using WorldMap.Infrastructure;
using WorldMap.Infrastructure.InMemory;
using WorldMap.Infrastructure.Secrets;
using WorldMap.UnitTests.Fakes;

namespace WorldMap.UnitTests.Services;

internal sealed class TestWorld
{
    public static readonly (string Token, string CivId, string SecretRef, string Secret)[] Records =
    [
        ("token-a", "civ_ra", "ref-a", "secret-a"),
        ("token-b", "civ_rb", "ref-b", "secret-b"),
        ("token-c", "civ_rc", "ref-c", "secret-c"),
    ];

    public TestWorld()
    {
        Options = Microsoft.Extensions.Options.Options.Create(new WorldMapOptions
        {
            ProtocolVersion = "1.0.0-test",
            WorldBaseUrl = "https://world.test/world/v1",
            Onboarding = new OnboardingOptions
            {
                Records = Records.Select(r => new OnboardingRecord
                {
                    Token = r.Token,
                    CivId = r.CivId,
                    KeyId = "key_01",
                    SecretRef = r.SecretRef,
                }).ToList(),
            },
            Liveness = new LivenessOptions { SuggestedHeartbeatSeconds = 15 },
            Interaction = new InteractionOptions { CommandTtlSeconds = 60, IdempotencyTtlSeconds = 5 },
            Events = new EventOptions { MaxBatchSize = 500, MaxPublicDataBytes = 4096 },
            Social = new SocialOptions
            {
                IdempotencyTtlSeconds = 5,
                RateLimit = new SocialRateLimitOptions { PostCooldownSeconds = 0 },
            },
            Secrets = new SecretsOptions
            {
                Map = Records.ToDictionary(r => r.SecretRef, r => r.Secret, StringComparer.Ordinal),
            },
        });

        Clock = new FakeTimeProvider(new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero));
        Civilizations = new InMemoryCivilizationRepository();
        Credentials = new InMemoryCivCredentialRepository();
        OnboardingTokens = new InMemoryOnboardingTokenStore();
        SecretStore = new InMemorySecretStore(Options.Value.Secrets.Map);
        IdempotencyStore = new InMemoryIdempotencyStore(Clock);
        Commands = new InMemoryCommandRepository(Clock);
        InteractionRepository = new InMemoryInteractionRepository();
        WorldEvents = new InMemoryWorldEventRepository();
        Relationships = new InMemoryRelationshipRepository();
        Sink = new CapturingWorldEventSink();

        var registry = new OnboardingRegistry(Options, NullLogger<OnboardingRegistry>.Instance);
        Idempotency = new IdempotencyExecutor(IdempotencyStore, Clock, NullLogger<IdempotencyExecutor>.Instance);
        Processor = CreateProcessor(WorldEvents, Relationships, Commands);
        Onboarding = new OnboardingService(
            Civilizations, Credentials, registry, OnboardingTokens, SecretStore, Idempotency,
            Clock, Options, NullLogger<OnboardingService>.Instance);
        Civilization = new CivilizationService(
            Civilizations, Commands, Clock, Options, NullLogger<CivilizationService>.Instance);
        Events = new EventService(
            WorldEvents, Idempotency, Sink, Clock, Options, NullLogger<EventService>.Instance);
        Interactions = new InteractionService(
            Civilizations, InteractionRepository, Processor, Idempotency, Clock, Options,
            NullLogger<InteractionService>.Instance);
        Command = new CommandService(
            Commands, InteractionRepository, Idempotency, Clock, Options, NullLogger<CommandService>.Instance);
        Relationship = new RelationshipService(Relationships);

        // --- World Wire social ---
        SocialAccountRepo = new InMemorySocialAccountRepository();
        SocialPostRepo = new InMemorySocialPostRepository();
        SocialFollowRepo = new InMemorySocialFollowRepository();
        SocialLikeRepo = new InMemorySocialLikeRepository();
        SocialFeedRepo = new InMemorySocialFeedRepository();
        SocialSnapshotStore = new InMemorySocialSnapshotStore();
        SocialRateLimitStore = new InMemorySocialRateLimitStore();

        var socialEvents = new SocialEventFactory(Options);
        SocialRateLimiter = new SocialRateLimiter(SocialRateLimitStore, Clock, Options);
        SocialPipeline = new SocialMutationPipeline(IdempotencyStore, Idempotency, SocialRateLimiter, Options);
        SocialAccountService = new SocialAccountService(
            SocialAccountRepo, SocialFollowRepo, WorldEvents, Idempotency, socialEvents, Sink, Clock, Options,
            NullLogger<SocialAccountService>.Instance);
        SocialPostService = new SocialPostService(
            SocialAccountRepo, SocialPostRepo, SocialFeedRepo, WorldEvents, SocialPipeline, socialEvents, Sink, Clock,
            Options, NullLogger<SocialPostService>.Instance);
        SocialGraphService = new SocialGraphService(
            SocialAccountRepo, SocialPostRepo, SocialFollowRepo, SocialLikeRepo, WorldEvents, SocialPipeline, socialEvents, Sink, Clock);
        SocialFeedService = new SocialFeedService(
            SocialAccountRepo, SocialPostRepo, SocialFollowRepo, SocialFeedRepo, SocialSnapshotStore, Clock, Options);

        Maintenance = new MaintenanceService(
            Commands, InteractionRepository, Processor, SocialPostService, SocialGraphService, Clock, NullLogger<MaintenanceService>.Instance);
    }

    public IOptions<WorldMapOptions> Options { get; }
    public FakeTimeProvider Clock { get; }
    public InMemoryCivilizationRepository Civilizations { get; }
    public InMemoryCivCredentialRepository Credentials { get; }
    public InMemoryOnboardingTokenStore OnboardingTokens { get; }
    public InMemorySecretStore SecretStore { get; }
    public InMemoryIdempotencyStore IdempotencyStore { get; }
    public IdempotencyExecutor Idempotency { get; }
    public InMemoryCommandRepository Commands { get; }
    public InMemoryInteractionRepository InteractionRepository { get; }
    public InMemoryWorldEventRepository WorldEvents { get; }
    public InMemoryRelationshipRepository Relationships { get; }
    public CapturingWorldEventSink Sink { get; }
    public InteractionProcessor Processor { get; }
    public OnboardingService Onboarding { get; }
    public CivilizationService Civilization { get; }
    public EventService Events { get; }
    public InteractionService Interactions { get; }
    public CommandService Command { get; }
    public RelationshipService Relationship { get; }
    public MaintenanceService Maintenance { get; }

    public InMemorySocialAccountRepository SocialAccountRepo { get; }
    public InMemorySocialPostRepository SocialPostRepo { get; }
    public InMemorySocialFollowRepository SocialFollowRepo { get; }
    public InMemorySocialLikeRepository SocialLikeRepo { get; }
    public InMemorySocialFeedRepository SocialFeedRepo { get; }
    public InMemorySocialSnapshotStore SocialSnapshotStore { get; }
    public InMemorySocialRateLimitStore SocialRateLimitStore { get; }
    public SocialRateLimiter SocialRateLimiter { get; }
    public SocialMutationPipeline SocialPipeline { get; }
    public SocialAccountService SocialAccountService { get; }
    public SocialPostService SocialPostService { get; }
    public SocialGraphService SocialGraphService { get; }
    public SocialFeedService SocialFeedService { get; }

    public InteractionProcessor CreateProcessor(
        IWorldEventRepository worldEvents,
        IRelationshipRepository relationships,
        ICommandRepository commands) =>
        new(
            Civilizations,
            InteractionRepository,
            worldEvents,
            relationships,
            commands,
            new PublicEventFactory(Options),
            Sink,
            Clock,
            NullLogger<InteractionProcessor>.Instance);

    public static CapabilitiesDto Capabilities => new()
    {
        ProtocolVersion = "1.0",
        SupportedInteractionKinds = ["contact", "message"],
    };

    public async Task<Civilization> SeedCivAsync(string civId, string? displayName = null)
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
        };
        await Civilizations.UpsertAsync(civ, CancellationToken.None);
        return civ;
    }

    public async Task<(string Source, string Target)> SeedCivPairAsync()
    {
        await SeedCivAsync("civ_a", "Aurora");
        await SeedCivAsync("civ_b", "Borealis");
        return ("civ_a", "civ_b");
    }

    public static InteractionRequestDto ContactRequest(string source, string target, string? greeting = "Greetings") => new()
    {
        Kind = "contact",
        Source = source,
        Target = target,
        AuthorityDecision = new AuthorityDecisionDto { Mode = "president" },
        PublicNarrative = "First contact",
        Payload = JsonSerializer.SerializeToNode(new ContactIntentDataDto { Greeting = greeting! }),
    };

    public static InteractionRequestDto MessageRequest(string source, string target, string? body = "Hello") => new()
    {
        Kind = "message",
        Source = source,
        Target = target,
        AuthorityDecision = new AuthorityDecisionDto { Mode = "president" },
        Payload = JsonSerializer.SerializeToNode(new MessageIntentDataDto { Body = body!, Subject = "Trade" }),
    };
}
