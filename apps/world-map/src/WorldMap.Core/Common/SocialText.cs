using System.Text;

namespace WorldMap.Core.Common;

/// <summary>
/// Unicode code-point (scalar) text validation for World Wire content. Bounds are measured with
/// <see cref="System.Text.Rune"/> enumeration (NOT UTF-16 <c>string.Length</c>) exactly as the contract
/// requires. Malformed UTF-16 (lone surrogates) and whitespace-only content are rejected. Validation
/// never mutates the input; callers store the exact submitted string without trimming or normalization.
/// </summary>
public static class SocialText
{
    /// <summary>Counts Unicode code points (runes) in a string.</summary>
    public static int CountRunes(string value)
    {
        var count = 0;
        foreach (var _ in value.EnumerateRunes())
        {
            count++;
        }

        return count;
    }

    /// <summary>True when the string contains no unpaired UTF-16 surrogates (well-formed Unicode).</summary>
    public static bool IsWellFormed(string value)
    {
        for (var i = 0; i < value.Length; i++)
        {
            var c = value[i];
            if (char.IsHighSurrogate(c))
            {
                if (i + 1 >= value.Length || !char.IsLowSurrogate(value[i + 1]))
                {
                    return false;
                }

                i++; // valid surrogate pair
            }
            else if (char.IsLowSurrogate(c))
            {
                return false; // a low surrogate without a preceding high surrogate
            }
        }

        return true;
    }

    /// <summary>True when at least one rune is a non-whitespace scalar.</summary>
    public static bool HasNonWhitespace(string value)
    {
        foreach (var rune in value.EnumerateRunes())
        {
            if (!Rune.IsWhiteSpace(rune))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Validates post/reply text: well-formed, 1..<paramref name="max"/> code points, at least one
    /// non-whitespace. Returns null on success or the mapped error.
    /// </summary>
    public static ErrorInfo? ValidatePostText(string? text, int max)
    {
        if (text is null || !IsWellFormed(text) || !HasNonWhitespace(text))
        {
            return ErrorResult.Create(ErrorCode.InvalidSocialContent,
                "Post text must be well-formed, non-empty, and contain a non-whitespace character.",
                errors: [new FieldError("/text", "invalid or empty content.")]);
        }

        var count = CountRunes(text);
        if (count < 1 || !HasNonWhitespace(text))
        {
            return ErrorResult.Create(ErrorCode.InvalidSocialContent,
                "Post text must contain at least one non-whitespace code point.",
                errors: [new FieldError("/text", "empty content.")]);
        }

        return count > max
            ? ErrorResult.Create(ErrorCode.ContentTooLong, $"Post text exceeds {max} Unicode code points.",
                errors: [new FieldError("/text", $"must be at most {max} code points.")])
            : null;
    }

    /// <summary>Validates a display name: well-formed, 1..<paramref name="max"/> code points, non-whitespace.</summary>
    public static ErrorInfo? ValidateDisplayName(string? displayName, int max)
    {
        if (displayName is null || !IsWellFormed(displayName) || !HasNonWhitespace(displayName))
        {
            return ErrorResult.Create(ErrorCode.InvalidSocialContent,
                "Display name must be well-formed and contain a non-whitespace character.",
                errors: [new FieldError("/actor/displayName", "invalid or empty display name.")]);
        }

        return CountRunes(displayName) > max
            ? ErrorResult.Create(ErrorCode.ContentTooLong, $"Display name exceeds {max} Unicode code points.",
                errors: [new FieldError("/actor/displayName", $"must be at most {max} code points.")])
            : null;
    }

    /// <summary>Validates a bio: well-formed, 0..<paramref name="max"/> code points (whitespace/empty allowed).</summary>
    public static ErrorInfo? ValidateBio(string? bio, int max)
    {
        if (bio is null)
        {
            return null;
        }

        if (!IsWellFormed(bio))
        {
            return ErrorResult.Create(ErrorCode.InvalidSocialContent, "Bio contains malformed Unicode.",
                errors: [new FieldError("/bio", "malformed content.")]);
        }

        return CountRunes(bio) > max
            ? ErrorResult.Create(ErrorCode.ContentTooLong, $"Bio exceeds {max} Unicode code points.",
                errors: [new FieldError("/bio", $"must be at most {max} code points.")])
            : null;
    }
}
