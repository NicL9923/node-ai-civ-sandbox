using System.Text.Json.Nodes;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Common;
using WorldMap.Core.Contracts;
using WorldMap.Core.Domain;

namespace WorldMap.UnitTests.Services;

/// <summary>
/// Regression coverage for the round-3 remediation: onboarding token-anchored idempotency (#2),
/// mutually-exclusive command ack/expiry (#3), namespaced event dedupe (#6), and event size limits (#7).
/// </summary>
public sealed class RemediationRegressionTests
{
    // ---- #2 onboarding: token-anchored, key-independent, create-only ----

    [Fact]
    public async Task Register_DifferentIdempotencyKeyButSameProfile_ReplaysDuplicate()
    {
        var world = new TestWorld();

        var first = await world.Onboarding.RegisterAsync(Request("token-a", "Aurora"), "key-1", default);
        var second = await world.Onboarding.RegisterAsync(Request("token-a", "Aurora"), "different-key", default);

        Assert.True(first.IsSuccess);
        Assert.False(first.Value.Body.Duplicate);
        Assert.True(second.IsSuccess);
        Assert.True(second.Value.Body.Duplicate); // token-anchored replay, independent of the HTTP key
        Assert.Equal(first.Value.Body.CivId, second.Value.Body.CivId);
        Assert.Single(await world.Civilizations.ListAllAsync(default));
    }

    [Fact]
    public async Task Register_SameTokenDifferentProfile_ConflictsAndDoesNotMutateCiv()
    {
        var world = new TestWorld();

        var first = await world.Onboarding.RegisterAsync(Request("token-a", "Aurora"), "key-1", default);
        Assert.True(first.IsSuccess);

        var conflict = await world.Onboarding.RegisterAsync(Request("token-a", "Totally Different"), "key-2", default);

        Assert.False(conflict.IsSuccess);
        Assert.Equal(ErrorCode.RegistrationConflict, conflict.Error.Code);

        // The civ is never re-bound/mutated by a later, different registration.
        var civ = await world.Civilizations.GetAsync("civ_ra", default);
        Assert.Equal("Aurora", civ!.DisplayName);
    }

    // ---- #3 command ack vs expiry: mutually exclusive terminal transition ----

    [Fact]
    public async Task ExpiryDoesNotWinAfterAck()
    {
        var world = new TestWorld();
        await world.Commands.EnqueueAsync(Command("cmd"), default);

        var ack = await world.Commands.TryAckAsync("civ", "cmd", CommandAckStatus.Applied, world.Clock.GetUtcNow(), default);
        Assert.Equal(CommandAckOutcome.Applied, ack.Outcome);

        // Expiry must NOT win over an already-acked command.
        Assert.False(await world.Commands.MarkExpiredAsync("civ", "cmd", default));
    }

    [Fact]
    public async Task AckDoesNotWinAfterExpiry_AndServiceReturnsNotFound()
    {
        var world = new TestWorld();
        await world.Commands.EnqueueAsync(Command("cmd"), default);

        Assert.True(await world.Commands.MarkExpiredAsync("civ", "cmd", default));

        // Repo: the ack loses to the prior expiry.
        var transition = await world.Commands.TryAckAsync("civ", "cmd", CommandAckStatus.Applied, world.Clock.GetUtcNow(), default);
        Assert.Equal(CommandAckOutcome.Expired, transition.Outcome);

        // Service: acking an expired command is a 404 (no longer acknowledgeable).
        var ack = await world.Command.AckAsync("civ", "cmd", new CommandAckDto { Status = "applied" }, "key", default);
        Assert.False(ack.IsSuccess);
        Assert.Equal(ErrorCode.CommandNotFound, ack.Error.Code);
    }

    [Fact]
    public async Task ConcurrentDifferentAcks_FirstWins_SecondReplaysSameStatus()
    {
        var world = new TestWorld();
        await world.Commands.EnqueueAsync(Command("cmd"), default);
        var now = world.Clock.GetUtcNow();

        var first = await world.Commands.TryAckAsync("civ", "cmd", CommandAckStatus.Applied, now, default);
        var second = await world.Commands.TryAckAsync("civ", "cmd", CommandAckStatus.Rejected, now, default);

        Assert.Equal(CommandAckOutcome.Applied, first.Outcome);
        Assert.Equal(CommandAckOutcome.AlreadyAcked, second.Outcome);
        Assert.Equal(CommandAckStatus.Applied, second.Command.AckStatus); // the winner's status is preserved
    }

    // ---- #6 namespaced event dedupe ----

    [Fact]
    public async Task IdempotencyKeyCannotCollideWithSourceIdFallback()
    {
        var world = new TestWorld();

        // Event A carries an idempotency key whose VALUE mimics the "source|id" fallback text.
        var withKey = new CloudEventDto
        {
            Id = "a1",
            Specversion = "1.0",
            Type = "civ.turn.completed.v1",
            Source = "/civilizations/civ_a",
            Idempotencykey = "/civilizations/civ_a|evt1",
        };
        // Event B has NO key; its source+id would form that same fallback text under a naive scheme.
        var withoutKey = new CloudEventDto
        {
            Id = "evt1",
            Specversion = "1.0",
            Type = "civ.turn.completed.v1",
            Source = "/civilizations/civ_a",
        };

        var result = await world.Events.IngestBatchAsync(
            "civ_a", new EventBatchDto { Events = [withKey, withoutKey] }, "batch", default);

        Assert.True(result.IsSuccess);
        Assert.Equal(["accepted", "accepted"], result.Value.Results.Select(r => r.Status)); // distinct, not a false dupe
        Assert.Equal(2, (await world.WorldEvents.ListAsync(0, 10, default)).Items.Count);
    }

    // ---- #7 event size limits (measured before any persistence) ----

    [Fact]
    public async Task OversizedEventEnvelopeRejected_ZeroPersistence()
    {
        var world = new TestWorld();
        var big = new CloudEventDto
        {
            Id = "big",
            Specversion = "1.0",
            Type = "civ.turn.completed.v1",
            Source = "/civilizations/civ_a",
            Data = new JsonObject { ["blob"] = new string('x', 70_000) }, // > 64 KB default MaxEventBytes
        };

        var result = await world.Events.IngestBatchAsync("civ_a", new EventBatchDto { Events = [big] }, "batch", default);

        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.PayloadTooLarge, result.Error.Code);
        Assert.Empty((await world.WorldEvents.ListAsync(0, 10, default)).Items);
    }

    [Fact]
    public async Task OverlongFieldRejected_ZeroPersistence()
    {
        var world = new TestWorld();
        var evt = new CloudEventDto
        {
            Id = "e",
            Specversion = "1.0",
            Type = "civ.turn.completed.v1",
            Source = "/civilizations/civ_a",
            Subject = new string('s', 4096), // > 1024 default MaxFieldChars
        };

        var result = await world.Events.IngestBatchAsync("civ_a", new EventBatchDto { Events = [evt] }, "batch", default);

        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.PayloadTooLarge, result.Error.Code);
        Assert.Empty((await world.WorldEvents.ListAsync(0, 10, default)).Items);
    }

    private static RegistrationRequestDto Request(string token, string displayName) => new()
    {
        OnboardingToken = token,
        DisplayName = displayName,
        Capabilities = TestWorld.Capabilities,
    };

    private static Command Command(string id) => new()
    {
        CommandId = id,
        TargetCivId = "civ",
        EventId = $"event-{id}",
        Type = "test",
        Source = "/world",
        DeliveredAt = DateTimeOffset.UtcNow,
        CreatedAt = DateTimeOffset.UtcNow,
    };
}
