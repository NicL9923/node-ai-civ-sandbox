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
}
