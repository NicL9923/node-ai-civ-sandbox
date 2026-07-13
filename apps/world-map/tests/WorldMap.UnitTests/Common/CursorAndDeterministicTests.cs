using System.Text;
using WorldMap.Core.Common;

namespace WorldMap.UnitTests.Common;

public sealed class CursorAndDeterministicTests
{
    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(long.MaxValue)]
    public void Cursor_RoundTrips(long ordinal)
    {
        Assert.True(CursorCodec.TryDecode(CursorCodec.Encode(ordinal), out var decoded));
        Assert.Equal(ordinal, decoded);
    }

    [Theory]
    [InlineData("not-base64!")]
    [InlineData("e30")]
    [InlineData("eyJvIjoibm90LWEtbnVtYmVyIn0")]
    public void Cursor_Malformed_ReturnsFalse(string cursor) =>
        Assert.False(CursorCodec.TryDecode(cursor, out _));

    [Fact]
    public void Cursor_Negative_ReturnsFalse()
    {
        var cursor = Convert.ToBase64String(Encoding.UTF8.GetBytes("{\"o\":-1}"))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');
        Assert.False(CursorCodec.TryDecode(cursor, out _));
    }

    [Fact]
    public void Cursor_Blank_StartsAtZero()
    {
        Assert.True(CursorCodec.TryDecode(null, out var ordinal));
        Assert.Equal(0, ordinal);
    }

    [Fact]
    public void DeterministicHashing_IsStableAndSeparatesInputs()
    {
        Assert.Equal(Deterministic.Sha256Hex("same"), Deterministic.Sha256Hex("same"));
        Assert.Equal(64, Deterministic.Sha256Hex("same").Length);
        Assert.Equal(32, Deterministic.ShortHash("same").Length);
        Assert.NotEqual(Deterministic.Id("x_", "ab", "c"), Deterministic.Id("x_", "a", "bc"));
    }
}
