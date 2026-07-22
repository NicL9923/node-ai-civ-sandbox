using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using WorldMap.Core.Contracts;
using WorldMap.IntegrationTests.Harness;

namespace WorldMap.IntegrationTests.Tests;

/// <summary>
/// Contract conformance: each example wire fixture deserializes into the matching
/// System.Text.Json DTO with <c>WorldMapJson.Options</c> and re-serializes with NO DATA LOSS —
/// every property/value present in the original example survives the round-trip (semantic,
/// order-tolerant compare). This proves our STJ DTOs conform to the generated contract shapes.
///
/// <c>problemDetails.json</c> has no <c>WorldMap.Core.Contracts</c> DTO; it is round-tripped
/// through <see cref="ProblemDetails"/>, the exact type the API emits via <c>ApiResults</c>.
/// </summary>
public sealed class ContractConformanceTests
{
    public static IEnumerable<object[]> Fixtures() =>
    [
        ["register.response.json", typeof(RegistrationResponseDto)],
        ["heartbeat.request.json", typeof(HeartbeatDto)],
        ["command.json", typeof(CommandDto)],
        ["interaction.contact.request.json", typeof(InteractionRequestDto)],
        ["interaction.message.request.json", typeof(InteractionRequestDto)],
        ["eventBatch.request.json", typeof(EventBatchDto)],
        ["commandAck.request.json", typeof(CommandAckDto)],
        ["problemDetails.json", typeof(ProblemDetails)],

        // World Wire social wire shapes.
        ["social.account-sync.request.json", typeof(SocialAccountSyncRequestDto)],
        ["social.account-sync.response.json", typeof(SocialAccountSyncResponseDto)],
        ["social.post.json", typeof(SocialPostDto)],
        ["social.post-tombstone.json", typeof(SocialPostDto)],
        ["social.post-create.request.json", typeof(SocialPostCreateRequestDto)],
        ["social.official-post-create.request.json", typeof(SocialPostCreateRequestDto)],
        ["social.reply-create.request.json", typeof(SocialPostCreateRequestDto)],
        ["social.follow-set.request.json", typeof(SocialFollowSetRequestDto)],
        ["social.reaction-set.request.json", typeof(SocialReactionSetRequestDto)],
        ["social.feed.page.json", typeof(SocialPostPageDto)],
        ["social.event.account-synced.data.json", typeof(SocialAccountSyncedEventDataDto)],
        ["social.event.post-created.data.json", typeof(SocialPostEventDataDto)],
        ["social.event.reply-created.data.json", typeof(SocialPostEventDataDto)],
        ["social.event.reaction-changed.data.json", typeof(SocialPostReactionChangedEventDataDto)],
        ["social.event.follow-changed.data.json", typeof(SocialFollowChangedEventDataDto)],
        ["social.event.post-tombstoned.data.json", typeof(SocialPostTombstonedEventDataDto)],
    ];

    [Theory]
    [MemberData(nameof(Fixtures))]
    public void Example_fixture_round_trips_without_data_loss(string fileName, Type dtoType)
    {
        var path = Path.Combine(AppContext.BaseDirectory, "Fixtures", fileName);
        var originalText = File.ReadAllText(path);

        var dto = JsonSerializer.Deserialize(originalText, dtoType, WorldMapJson.Options);
        Assert.NotNull(dto);

        var roundTripped = JsonSerializer.Serialize(dto, dtoType, WorldMapJson.Options);

        using var original = JsonDocument.Parse(originalText);
        using var actual = JsonDocument.Parse(roundTripped);

        JsonSubset.AssertContains(original.RootElement, actual.RootElement);
    }

    [Fact]
    public void CloudEvent_with_unknown_extension_attribute_round_trips_without_loss()
    {
        // A forward-compatible producer sends an extension attribute the DTO does not model
        // explicitly. It must be captured by JsonExtensionData and survive the round-trip so
        // ingestion never silently drops unknown-but-valid CloudEvents attributes.
        const string original = """
        {
          "id": "civ_aurora-evt-9001",
          "specversion": "1.0",
          "type": "civ.agent.acted.v1",
          "source": "/civilizations/civ_aurora",
          "time": "2026-07-10T18:04:00Z",
          "data": { "action": "gather" },
          "idempotencykey": "civ_aurora-9001",
          "traceparent": "00-abcd1234abcd1234abcd1234abcd1234-1234abcd1234abcd-01",
          "regionhint": "eu-west"
        }
        """;

        var dto = JsonSerializer.Deserialize<CloudEventDto>(original, WorldMapJson.Options);
        Assert.NotNull(dto);
        Assert.NotNull(dto!.Extensions);
        Assert.True(dto.Extensions!.ContainsKey("traceparent"));
        Assert.True(dto.Extensions.ContainsKey("regionhint"));

        var roundTripped = JsonSerializer.Serialize(dto, WorldMapJson.Options);

        using var expected = JsonDocument.Parse(original);
        using var actual = JsonDocument.Parse(roundTripped);
        JsonSubset.AssertContains(expected.RootElement, actual.RootElement);

        // Explicitly assert the unknown extension attributes survived by value.
        var root = actual.RootElement;
        Assert.Equal(
            "00-abcd1234abcd1234abcd1234abcd1234-1234abcd1234abcd-01",
            root.GetProperty("traceparent").GetString());
        Assert.Equal("eu-west", root.GetProperty("regionhint").GetString());
    }
}
