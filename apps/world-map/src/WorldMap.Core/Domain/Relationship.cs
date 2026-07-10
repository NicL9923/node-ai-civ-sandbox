using WorldMap.Core.Contracts;

namespace WorldMap.Core.Domain;

/// <summary>
/// Public relationship projection between two civilizations. The pair is canonicalized
/// so <c>CivA &lt;= CivB</c> (ordinal), giving a single stable <see cref="PairKey"/>.
/// All dimensions are bounded to the contract ranges and updated deterministically.
/// </summary>
public sealed class Relationship
{
    public required string PairKey { get; set; }
    public required string CivA { get; set; }
    public required string CivB { get; set; }

    public double Trust { get; set; }           // [-1, 1]
    public double Grievance { get; set; }        // [0, 100]
    public double Threat { get; set; }           // [0, 100]
    public double Familiarity { get; set; }      // [0, 1]
    public double Interdependence { get; set; }  // [0, 1]
    public string Stance { get; set; } = "neutral";
    public string? NarrativeSummary { get; set; }

    /// <summary>Monotonic version for optimistic concurrency (mirrored to etag).</summary>
    public int Version { get; set; }

    public string? Etag { get; set; }

    /// <summary>Stable ordinal for deterministic list pagination.</summary>
    public long Ordinal { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }

    /// <summary>Canonical pair key with <c>CivA &lt;= CivB</c> ordering.</summary>
    public static (string CivA, string CivB) Canonicalize(string civ1, string civ2) =>
        string.CompareOrdinal(civ1, civ2) <= 0 ? (civ1, civ2) : (civ2, civ1);

    public static string PairKeyFor(string civ1, string civ2)
    {
        var (a, b) = Canonicalize(civ1, civ2);
        return $"{a}|{b}";
    }

    /// <summary>Creates a fresh neutral relationship for a canonical pair.</summary>
    public static Relationship CreateNeutral(string civ1, string civ2, long ordinal, DateTimeOffset now)
    {
        var (a, b) = Canonicalize(civ1, civ2);
        return new Relationship
        {
            PairKey = $"{a}|{b}",
            CivA = a,
            CivB = b,
            Trust = 0,
            Grievance = 0,
            Threat = 0,
            Familiarity = 0,
            Interdependence = 0,
            Stance = "neutral",
            Version = 0,
            Ordinal = ordinal,
            CreatedAt = now,
            UpdatedAt = now,
        };
    }

    public RelationshipDto ToDto() => new()
    {
        Pair = new CivPairDto { CivA = CivA, CivB = CivB },
        Trust = Trust,
        Grievance = Grievance,
        Threat = Threat,
        Familiarity = Familiarity,
        Interdependence = Interdependence,
        Stance = Stance,
        NarrativeSummary = NarrativeSummary,
        Version = Version,
        Etag = Etag ?? Version.ToString(),
        UpdatedAt = UpdatedAt,
    };
}

/// <summary>
/// Deterministic (no-LLM) relationship transitions. Contact modestly raises familiarity;
/// a public message updates the narrative and nudges familiarity. Trust/grievance/threat/
/// interdependence stay bounded and are not invented from message content.
/// </summary>
public static class RelationshipMath
{
    public const double ContactFamiliarityDelta = 0.10;
    public const double MessageFamiliarityDelta = 0.02;
    public const double FriendlyFamiliarityThreshold = 0.60;

    private static double Clamp(double v, double lo, double hi) => v < lo ? lo : (v > hi ? hi : v);

    public static void ApplyContact(Relationship rel, DateTimeOffset now)
    {
        rel.Familiarity = Clamp(rel.Familiarity + ContactFamiliarityDelta, 0, 1);
        rel.Stance = RecomputeStance(rel);
        Bump(rel, now);
    }

    public static void ApplyMessage(Relationship rel, string fromDisplayName, string? subject, DateTimeOffset now)
    {
        rel.Familiarity = Clamp(rel.Familiarity + MessageFamiliarityDelta, 0, 1);
        rel.NarrativeSummary = string.IsNullOrWhiteSpace(subject)
            ? $"{fromDisplayName} sent a public message."
            : $"{fromDisplayName} sent a public message: \"{subject}\".";
        rel.Stance = RecomputeStance(rel);
        Bump(rel, now);
    }

    private static string RecomputeStance(Relationship rel)
    {
        // Deterministic, bounded: MVP only steps neutral -> friendly on familiarity.
        if (rel.Grievance >= 50 || rel.Threat >= 50)
        {
            return "wary";
        }

        return rel.Familiarity >= FriendlyFamiliarityThreshold ? "friendly" : "neutral";
    }

    private static void Bump(Relationship rel, DateTimeOffset now)
    {
        rel.Trust = Clamp(rel.Trust, -1, 1);
        rel.Grievance = Clamp(rel.Grievance, 0, 100);
        rel.Threat = Clamp(rel.Threat, 0, 100);
        rel.Interdependence = Clamp(rel.Interdependence, 0, 1);
        rel.Version += 1;
        rel.UpdatedAt = now;
    }
}
