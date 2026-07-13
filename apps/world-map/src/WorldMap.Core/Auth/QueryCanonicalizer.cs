using System.Text;

namespace WorldMap.Core.Auth;

/// <summary>
/// Canonicalizes an HTTP query string per the federation signing spec (field 9 of
/// the HMAC canonical string). Pure and allocation-light so it can be shared by the
/// auth middleware and exercised directly by the golden-vector tests.
///
/// Algorithm: split into <c>key=value</c> pairs; percent-DECODE each key and value
/// as <c>application/x-www-form-urlencoded</c> (so <c>+</c> becomes a space); then
/// RFC 3986 percent-ENCODE each (unreserved <c>A-Za-z0-9-._~</c> stay literal, a
/// space becomes <c>%20</c> never <c>+</c>, all escapes UPPERCASE hex); sort by
/// encoded key then encoded value (ordinal), preserving repeats; join <c>key=value</c>
/// with <c>&amp;</c>; no leading <c>?</c>.
/// </summary>
public static class QueryCanonicalizer
{
    public static string Canonicalize(string? rawQuery)
    {
        if (string.IsNullOrEmpty(rawQuery))
        {
            return string.Empty;
        }

        // Tolerate a leading '?' even though callers should strip it.
        var query = rawQuery[0] == '?' ? rawQuery[1..] : rawQuery;
        if (query.Length == 0)
        {
            return string.Empty;
        }

        var pairs = new List<(string Key, string Value)>();
        foreach (var segment in query.Split('&'))
        {
            if (segment.Length == 0)
            {
                continue;
            }

            var eq = segment.IndexOf('=');
            string rawKey;
            string rawValue;
            if (eq < 0)
            {
                rawKey = segment;
                rawValue = string.Empty;
            }
            else
            {
                rawKey = segment[..eq];
                rawValue = segment[(eq + 1)..];
            }

            var key = Rfc3986Encode(FormUrlDecode(rawKey));
            var value = Rfc3986Encode(FormUrlDecode(rawValue));
            pairs.Add((key, value));
        }

        pairs.Sort(static (a, b) =>
        {
            var byKey = string.CompareOrdinal(a.Key, b.Key);
            return byKey != 0 ? byKey : string.CompareOrdinal(a.Value, b.Value);
        });

        var sb = new StringBuilder(query.Length + 16);
        for (var i = 0; i < pairs.Count; i++)
        {
            if (i > 0)
            {
                sb.Append('&');
            }

            sb.Append(pairs[i].Key).Append('=').Append(pairs[i].Value);
        }

        return sb.ToString();
    }

    /// <summary>
    /// Decodes an <c>application/x-www-form-urlencoded</c> component: <c>+</c> maps to
    /// a space and <c>%XX</c> escapes decode to their raw bytes (interpreted as UTF-8).
    /// </summary>
    private static string FormUrlDecode(string s)
    {
        if (s.Length == 0)
        {
            return string.Empty;
        }

        var bytes = new List<byte>(s.Length);
        for (var i = 0; i < s.Length; i++)
        {
            var c = s[i];
            if (c == '+')
            {
                bytes.Add((byte)' ');
            }
            else if (c == '%' && i + 2 < s.Length && TryHex(s[i + 1], out var hi) && TryHex(s[i + 2], out var lo))
            {
                bytes.Add((byte)((hi << 4) | lo));
                i += 2;
            }
            else
            {
                // Raw character (may include a literal space in test vectors). Encode as UTF-8.
                foreach (var b in Encoding.UTF8.GetBytes(c.ToString()))
                {
                    bytes.Add(b);
                }
            }
        }

        return Encoding.UTF8.GetString(bytes.ToArray());
    }

    /// <summary>
    /// RFC 3986 percent-encodes a string: unreserved characters stay literal; every
    /// other UTF-8 byte becomes <c>%XX</c> with UPPERCASE hex. A space becomes
    /// <c>%20</c> (never <c>+</c>).
    /// </summary>
    public static string Rfc3986Encode(string s)
    {
        var bytes = Encoding.UTF8.GetBytes(s);
        var sb = new StringBuilder(bytes.Length * 3);
        foreach (var b in bytes)
        {
            if (IsUnreserved(b))
            {
                sb.Append((char)b);
            }
            else
            {
                sb.Append('%');
                sb.Append(HexUpper(b >> 4));
                sb.Append(HexUpper(b & 0xF));
            }
        }

        return sb.ToString();
    }

    private static bool IsUnreserved(byte b) =>
        (b >= 'A' && b <= 'Z') ||
        (b >= 'a' && b <= 'z') ||
        (b >= '0' && b <= '9') ||
        b == '-' || b == '.' || b == '_' || b == '~';

    private static char HexUpper(int nibble) => (char)(nibble < 10 ? '0' + nibble : 'A' + (nibble - 10));

    private static bool TryHex(char c, out int value)
    {
        if (c >= '0' && c <= '9') { value = c - '0'; return true; }
        if (c >= 'a' && c <= 'f') { value = c - 'a' + 10; return true; }
        if (c >= 'A' && c <= 'F') { value = c - 'A' + 10; return true; }
        value = 0;
        return false;
    }
}
