using System.Text.Json.Nodes;
using WorldMap.Core.Contracts;

namespace WorldMap.IntegrationTests.Harness;

/// <summary>Factory builders for the request DTOs used across the integration suite.</summary>
public static class TestDtos
{
    public static RegistrationRequestDto Registration(string onboardingToken, string displayName) => new()
    {
        OnboardingToken = onboardingToken,
        DisplayName = displayName,
        Capabilities = new CapabilitiesDto
        {
            ProtocolVersion = "1.0.0",
            SupportedInteractionKinds = ["contact", "message"],
            MaxEventBatchSize = 200,
            Features = ["public-events"],
        },
        PublicKey = "MCowBQYDK2VwAyEA...",
        Contact = "ops@test.example",
    };

    public static HeartbeatDto Heartbeat(string civId, string displayName, int turn = 1) => new()
    {
        Projection = new PublicProjectionDto
        {
            CivId = civId,
            DisplayName = displayName,
            ProtocolVersion = "1.0.0",
            Turn = turn,
            Running = true,
            Population = 10,
            President = new LeaderDto { Ref = "leader_current", Name = "Silas", Title = "President", TermNumber = 1 },
            Economy = new EconomySummaryDto { Treasury = 1000, Currency = "credits" },
            UpdatedAt = DateTimeOffset.UtcNow,
        },
        LastProcessedWorldCursor = null,
    };

    public static InteractionRequestDto ContactInteraction(string source, string target, string greeting) => new()
    {
        Kind = "contact",
        Source = source,
        Target = target,
        AuthorityDecision = new AuthorityDecisionDto
        {
            Mode = "president",
            Ref = "decree_1",
            AuthorizedAt = DateTimeOffset.UtcNow,
        },
        PublicNarrative = "A formal greeting.",
        Payload = new JsonObject
        {
            ["greeting"] = greeting,
            ["purpose"] = "diplomacy",
        },
    };

    public static CommandAckDto AppliedAck() => new()
    {
        Status = "applied",
        Detail = "Command applied and surfaced to citizens.",
        AppliedAt = DateTimeOffset.UtcNow,
    };

    public static InteractionRequestDto MessageInteraction(string source, string target, string body, string? subject = null) => new()
    {
        Kind = "message",
        Source = source,
        Target = target,
        AuthorityDecision = new AuthorityDecisionDto
        {
            Mode = "president",
            Ref = "decree_2",
            AuthorizedAt = DateTimeOffset.UtcNow,
        },
        PublicNarrative = "A diplomatic message.",
        Payload = new JsonObject
        {
            ["body"] = body,
            ["subject"] = subject,
        },
    };

    /// <summary>A single civ-sourced CloudEvent carrying arbitrary producer data (never surfaced publicly).</summary>
    public static CloudEventDto CivEvent(string civId, string id, string idempotencyKey, JsonNode? data = null) => new()
    {
        Id = id,
        Specversion = "1.0",
        Type = "civ.agent.acted.v1",
        Source = $"/civilizations/{civId}",
        Time = DateTimeOffset.UtcNow,
        Data = data ?? new JsonObject { ["agentRef"] = "a_1", ["action"] = "gather" },
        Idempotencykey = idempotencyKey,
    };

    /// <summary>Wraps a set of pre-built CloudEvents into a batch DTO (used by invalid/mixed-batch tests).</summary>
    public static EventBatchDto Batch(params CloudEventDto[] events) => new()
    {
        Events = events.ToList(),
    };

    public static EventBatchDto EventBatch(string civId, params (string Id, string IdempotencyKey)[] events) =>
        Batch(events.Select(e => CivEvent(civId, e.Id, e.IdempotencyKey)).ToArray());
}
