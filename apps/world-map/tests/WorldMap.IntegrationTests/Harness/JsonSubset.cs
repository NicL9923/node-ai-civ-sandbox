using System.Globalization;
using System.Text.Json;

namespace WorldMap.IntegrationTests.Harness;

/// <summary>
/// Recursive, order-tolerant semantic JSON subset comparison used by the contract-conformance
/// round-trip tests: asserts that every property/value present in <c>expected</c> (the original
/// example fixture) is present and semantically equal in <c>actual</c> (the DTO re-serialized
/// via <c>WorldMapJson.Options</c>). The round-trip may add nothing that contradicts the
/// original; extra properties in <c>actual</c> are ignored.
///
/// Semantic tolerances match the wire format:
/// <list type="bullet">
///   <item>A <c>null</c> in the original is satisfied by a matching <c>null</c> OR an omitted
///     property (the serializer drops null-valued optionals).</item>
///   <item>Date/time strings compare by instant (so <c>...Z</c> equals <c>...+00:00</c>).</item>
///   <item>Numbers compare by value (so <c>1200</c> equals <c>1200.0</c>).</item>
/// </list>
/// </summary>
public static class JsonSubset
{
    public static void AssertContains(JsonElement expected, JsonElement actual, string path = "$")
    {
        switch (expected.ValueKind)
        {
            case JsonValueKind.Object:
                foreach (var property in expected.EnumerateObject())
                {
                    var childPath = $"{path}.{property.Name}";
                    JsonElement actualValue = default;
                    var hasActual = actual.ValueKind == JsonValueKind.Object &&
                                    actual.TryGetProperty(property.Name, out actualValue);

                    if (property.Value.ValueKind == JsonValueKind.Null)
                    {
                        // Null in the original: fine if omitted or explicitly null in the round-trip.
                        if (hasActual)
                        {
                            Assert.True(
                                actualValue.ValueKind == JsonValueKind.Null,
                                $"At {childPath}: original is null but round-trip has non-null {actualValue.ValueKind}.");
                        }

                        continue;
                    }

                    Assert.True(hasActual, $"At {childPath}: property missing from round-trip output.");
                    AssertContains(property.Value, actualValue, childPath);
                }

                break;

            case JsonValueKind.Array:
                Assert.True(
                    actual.ValueKind == JsonValueKind.Array,
                    $"At {path}: expected array but round-trip has {actual.ValueKind}.");
                Assert.Equal(expected.GetArrayLength(), actual.GetArrayLength());

                var expectedItems = expected.EnumerateArray().ToArray();
                var actualItems = actual.EnumerateArray().ToArray();
                for (var i = 0; i < expectedItems.Length; i++)
                {
                    AssertContains(expectedItems[i], actualItems[i], $"{path}[{i}]");
                }

                break;

            case JsonValueKind.String:
                AssertStringEqual(expected, actual, path);
                break;

            case JsonValueKind.Number:
                Assert.True(
                    actual.ValueKind == JsonValueKind.Number,
                    $"At {path}: expected number but round-trip has {actual.ValueKind}.");
                Assert.True(
                    Math.Abs(expected.GetDouble() - actual.GetDouble()) < 1e-9,
                    $"At {path}: number {expected.GetDouble()} != {actual.GetDouble()}.");
                break;

            case JsonValueKind.True:
            case JsonValueKind.False:
                Assert.Equal(expected.ValueKind, actual.ValueKind);
                break;

            case JsonValueKind.Null:
                Assert.True(
                    actual.ValueKind == JsonValueKind.Null,
                    $"At {path}: expected null but round-trip has {actual.ValueKind}.");
                break;
        }
    }

    private static void AssertStringEqual(JsonElement expected, JsonElement actual, string path)
    {
        Assert.True(
            actual.ValueKind == JsonValueKind.String,
            $"At {path}: expected string but round-trip has {actual.ValueKind}.");

        var expectedStr = expected.GetString();
        var actualStr = actual.GetString();

        if (expectedStr == actualStr)
        {
            return;
        }

        // Tolerate date/time representations that differ textually but denote the same instant.
        if (TryParseInstant(expectedStr, out var e) && TryParseInstant(actualStr, out var a))
        {
            Assert.True(e == a, $"At {path}: instant {expectedStr} != {actualStr}.");
            return;
        }

        Assert.Equal(expectedStr, actualStr);
    }

    private static bool TryParseInstant(string? value, out DateTimeOffset instant)
    {
        instant = default;
        if (string.IsNullOrEmpty(value))
        {
            return false;
        }

        if (DateTimeOffset.TryParse(
                value,
                CultureInfo.InvariantCulture,
                DateTimeStyles.RoundtripKind | DateTimeStyles.AssumeUniversal,
                out var parsed))
        {
            instant = parsed.ToUniversalTime();
            return true;
        }

        return false;
    }
}
