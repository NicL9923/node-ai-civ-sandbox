using System.Text;
using System.Text.Json;
using WorldMap.Core.Auth;

namespace WorldMap.UnitTests.Auth;

/// <summary>
/// Validates the C# HMAC implementation against the language-agnostic golden vectors
/// in <c>packages/federation-contracts/examples/signing.vector.json</c>. Every
/// intermediate value (canonical query, body hash, canonical string, signature) is
/// asserted so a drift in any step is caught precisely.
/// </summary>
public sealed class SigningVectorTests
{
    private static readonly JsonDocument Vectors = LoadVectors();

    private static JsonDocument LoadVectors()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "Fixtures", "signing.vector.json");
        return JsonDocument.Parse(File.ReadAllText(path));
    }

    public static IEnumerable<object[]> VectorNames()
    {
        foreach (var v in Vectors.RootElement.GetProperty("vectors").EnumerateArray())
        {
            yield return [v.GetProperty("name").GetString()!];
        }
    }

    private static JsonElement VectorByName(string name)
    {
        foreach (var v in Vectors.RootElement.GetProperty("vectors").EnumerateArray())
        {
            if (v.GetProperty("name").GetString() == name)
            {
                return v;
            }
        }

        throw new InvalidOperationException($"Vector '{name}' not found.");
    }

    [Theory]
    [MemberData(nameof(VectorNames))]
    public void CanonicalQuery_matches_vector(string name)
    {
        var v = VectorByName(name);
        var input = v.GetProperty("input");
        var expected = v.GetProperty("expected").GetProperty("canonicalQuery").GetString();

        var actual = QueryCanonicalizer.Canonicalize(input.GetProperty("query").GetString());

        Assert.Equal(expected, actual);
    }

    [Theory]
    [MemberData(nameof(VectorNames))]
    public void BodySha256Hex_matches_vector(string name)
    {
        var v = VectorByName(name);
        var input = v.GetProperty("input");
        var expected = v.GetProperty("expected").GetProperty("bodySha256Hex").GetString();

        var body = Encoding.UTF8.GetBytes(input.GetProperty("body").GetString() ?? string.Empty);
        var actual = HmacCanonicalizer.BodySha256Hex(body);

        Assert.Equal(expected, actual);
    }

    [Theory]
    [MemberData(nameof(VectorNames))]
    public void CanonicalString_matches_vector(string name)
    {
        var v = VectorByName(name);
        var input = v.GetProperty("input");
        var expected = v.GetProperty("expected").GetProperty("canonicalString").GetString();

        var body = Encoding.UTF8.GetBytes(input.GetProperty("body").GetString() ?? string.Empty);
        var request = new HmacSignedRequest(
            ProtocolVersion: input.GetProperty("protocolVersion").GetString()!,
            CivId: input.GetProperty("civId").GetString()!,
            KeyId: input.GetProperty("keyId").GetString()!,
            Timestamp: input.GetProperty("timestamp").GetString()!,
            Nonce: input.GetProperty("nonce").GetString()!,
            IdempotencyKey: input.GetProperty("idempotencyKey").GetString()!,
            Method: input.GetProperty("method").GetString()!,
            Path: input.GetProperty("path").GetString()!,
            RawQuery: input.GetProperty("query").GetString()!,
            Body: body);

        var actual = HmacCanonicalizer.BuildCanonicalString(request);

        Assert.Equal(expected, actual);
    }

    [Theory]
    [MemberData(nameof(VectorNames))]
    public void Signature_matches_vector_and_verifies(string name)
    {
        var v = VectorByName(name);
        var input = v.GetProperty("input");
        var expectedCanonical = v.GetProperty("expected").GetProperty("canonicalString").GetString()!;
        var expectedSignature = v.GetProperty("expected").GetProperty("signature").GetString()!;
        var secret = input.GetProperty("secret").GetString()!;

        var actualSignature = HmacSigner.Sign(expectedCanonical, secret);

        Assert.Equal(expectedSignature, actualSignature);
        Assert.True(HmacSigner.Verify(expectedCanonical, secret, expectedSignature));
        Assert.False(HmacSigner.Verify(expectedCanonical, secret, expectedSignature + "x"));
        Assert.False(HmacSigner.Verify(expectedCanonical, "wrong-secret", expectedSignature));
    }
}
