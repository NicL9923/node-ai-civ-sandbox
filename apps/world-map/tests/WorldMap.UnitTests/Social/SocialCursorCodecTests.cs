using WorldMap.Core.Common;
using Xunit;

namespace WorldMap.UnitTests.Social;

/// <summary>The opaque, self-bound social snapshot cursor codec.</summary>
public sealed class SocialCursorCodecTests
{
    private static SocialCursorState State(string endpoint, string scope) => new()
    {
        Endpoint = endpoint,
        Scope = scope,
        Filter = string.Empty,
        Direction = "desc",
        HighWatermark = 4200,
        PositionWorldsequence = 4100,
        PositionTieId = "post_9",
    };

    [Fact]
    public void Encode_then_decode_round_trips()
    {
        var encoded = SocialCursorCodec.Encode(State("global-feed", ""));
        Assert.True(encoded.Length <= 4096);

        Assert.True(SocialCursorCodec.TryDecode(encoded, out var decoded));
        Assert.NotNull(decoded);
        Assert.Equal("global-feed", decoded!.Endpoint);
        Assert.Equal(4200, decoded.HighWatermark);
        Assert.Equal(4100, decoded.PositionWorldsequence);
        Assert.Equal("post_9", decoded.PositionTieId);
    }

    [Fact]
    public void Null_or_empty_decodes_to_first_page()
    {
        Assert.True(SocialCursorCodec.TryDecode(null, out var a));
        Assert.Null(a);
        Assert.True(SocialCursorCodec.TryDecode("", out var b));
        Assert.Null(b);
    }

    [Fact]
    public void Malformed_cursor_fails()
    {
        Assert.False(SocialCursorCodec.TryDecode("!!!not-base64!!!", out _));
        Assert.False(SocialCursorCodec.TryDecode("Zm9vYmFy", out _)); // valid base64 "foobar", not our JSON
    }

    [Fact]
    public void Binding_equality_detects_endpoint_or_scope_mismatch()
    {
        var encoded = SocialCursorCodec.Encode(State("account-posts", "acct_a"));
        Assert.True(SocialCursorCodec.TryDecode(encoded, out var decoded));

        Assert.Equal(new SocialCursorBinding("account-posts", "acct_a", "", "desc"), decoded!.Binding);
        Assert.NotEqual(new SocialCursorBinding("account-posts", "acct_b", "", "desc"), decoded.Binding);
        Assert.NotEqual(new SocialCursorBinding("global-feed", "", "", "desc"), decoded.Binding);
    }
}
