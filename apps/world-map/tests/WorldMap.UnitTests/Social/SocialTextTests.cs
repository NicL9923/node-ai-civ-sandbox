using WorldMap.Core.Common;
using Xunit;

namespace WorldMap.UnitTests.Social;

/// <summary>Unicode code-point (Rune) text validation for World Wire content.</summary>
public sealed class SocialTextTests
{
    [Fact]
    public void CountRunes_counts_code_points_not_utf16_units()
    {
        var emoji = string.Concat(Enumerable.Repeat("\U0001F642", 10)); // 10 runes, 20 UTF-16 units
        Assert.Equal(20, emoji.Length);
        Assert.Equal(10, SocialText.CountRunes(emoji));
    }

    [Fact]
    public void ValidatePostText_accepts_280_code_points_and_rejects_281()
    {
        Assert.Null(SocialText.ValidatePostText(new string('a', 280), 280));

        var tooLong = SocialText.ValidatePostText(new string('a', 281), 280);
        Assert.NotNull(tooLong);
        Assert.Equal(ErrorCode.ContentTooLong, tooLong!.Code);
    }

    [Fact]
    public void ValidatePostText_rejects_empty_whitespace_and_malformed()
    {
        Assert.Equal(ErrorCode.InvalidSocialContent, SocialText.ValidatePostText("", 280)!.Code);
        Assert.Equal(ErrorCode.InvalidSocialContent, SocialText.ValidatePostText("   \t\n", 280)!.Code);

        // A lone high surrogate is malformed Unicode.
        var malformed = "\uD83D";
        Assert.False(SocialText.IsWellFormed(malformed));
        Assert.Equal(ErrorCode.InvalidSocialContent, SocialText.ValidatePostText(malformed, 280)!.Code);
    }

    [Fact]
    public void ValidateBio_allows_empty_and_bounds_at_160()
    {
        Assert.Null(SocialText.ValidateBio(null, 160));
        Assert.Null(SocialText.ValidateBio("", 160));
        Assert.Null(SocialText.ValidateBio(new string('b', 160), 160));
        Assert.Equal(ErrorCode.ContentTooLong, SocialText.ValidateBio(new string('b', 161), 160)!.Code);
    }
}
