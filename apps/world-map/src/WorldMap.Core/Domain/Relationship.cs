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

    /// <summary>
    /// Contiguous high-water mark of applied interaction worldsequences: every sequence at or below
    /// this has been folded in. Combined with <see cref="RecentAppliedSequences"/> this makes
    /// relationship mutation exactly-once and ORDER-INDEPENDENT (interactions may be processed out of
    /// worldsequence order by independent process managers).
    /// </summary>
    public long AppliedHighWater { get; set; }

    /// <summary>
    /// Applied worldsequences not yet subsumed by <see cref="AppliedHighWater"/>. Because global
    /// worldsequences are sparse per pair, this is compacted only opportunistically; it grows with the
    /// number of interactions for the pair. Bounding/pruning it (relying on the interaction's process
    /// step to guard older replays) is a documented future optimization — MVP interaction volumes are
    /// modest. Correctness (exactly-once, order-independent) does not depend on compaction.
    /// </summary>
    public List<long> RecentAppliedSequences { get; set; } = [];

    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }

    /// <summary>True if the given interaction worldsequence has already been folded into this projection.</summary>
    public bool HasApplied(long worldsequence) =>
        worldsequence <= AppliedHighWater || RecentAppliedSequences.Contains(worldsequence);

    /// <summary>Canonical pair key with <c>CivA &lt;= CivB</c> ordering.</summary>
    public static (string CivA, string CivB) Canonicalize(string civ1, string civ2) =>
        string.CompareOrdinal(civ1, civ2) <= 0 ? (civ1, civ2) : (civ2, civ1);

    public static string PairKeyFor(string civ1, string civ2)
    {
        var (a, b) = Canonicalize(civ1, civ2);
        return $"{a}|{b}";
    }

    /// <summary>Creates a fresh neutral relationship for a canonical pair (ordinal assigned at insert).</summary>
    public static Relationship CreateNeutral(string civ1, string civ2, DateTimeOffset now)
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
            AppliedHighWater = 0,
            RecentAppliedSequences = [],
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
///
/// <para>Every transition is exactly-once and ORDER-INDEPENDENT: an interaction's <c>worldsequence</c>
/// is checked against the relationship's applied set (high-water mark + out-of-order window), so
/// replaying the same interaction is a no-op while a lower-sequence interaction processed after a
/// higher one is still applied.</para>
/// </summary>
public static class RelationshipMath
{
    public const double ContactFamiliarityDelta = 0.10;
    public const double MessageFamiliarityDelta = 0.02;
    public const double FriendlyFamiliarityThreshold = 0.60;

    private static double Clamp(double v, double lo, double hi) => v < lo ? lo : (v > hi ? hi : v);

    private static bool AlreadyApplied(Relationship rel, long worldsequence) =>
        worldsequence <= rel.AppliedHighWater || rel.RecentAppliedSequences.Contains(worldsequence);

    /// <summary>Applies a contact once. Returns false (no-op) if this worldsequence was already folded in.</summary>
    public static bool ApplyContact(Relationship rel, long worldsequence, DateTimeOffset now)
    {
        if (AlreadyApplied(rel, worldsequence))
        {
            return false;
        }

        rel.Familiarity = Clamp(rel.Familiarity + ContactFamiliarityDelta, 0, 1);
        rel.Stance = RecomputeStance(rel);
        Bump(rel, worldsequence, now);
        return true;
    }

    /// <summary>Applies a public message once. Returns false (no-op) if this worldsequence was already folded in.</summary>
    public static bool ApplyMessage(Relationship rel, long worldsequence, string fromDisplayName, string? subject, DateTimeOffset now)
    {
        if (AlreadyApplied(rel, worldsequence))
        {
            return false;
        }

        rel.Familiarity = Clamp(rel.Familiarity + MessageFamiliarityDelta, 0, 1);
        rel.NarrativeSummary = string.IsNullOrWhiteSpace(subject)
            ? $"{fromDisplayName} sent a public message."
            : $"{fromDisplayName} sent a public message: \"{subject}\".";
        rel.Stance = RecomputeStance(rel);
        Bump(rel, worldsequence, now);
        return true;
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

    private static void Bump(Relationship rel, long worldsequence, DateTimeOffset now)
    {
        rel.Trust = Clamp(rel.Trust, -1, 1);
        rel.Grievance = Clamp(rel.Grievance, 0, 100);
        rel.Threat = Clamp(rel.Threat, 0, 100);
        rel.Interdependence = Clamp(rel.Interdependence, 0, 1);
        MarkApplied(rel, worldsequence);
        rel.Version += 1;
        rel.UpdatedAt = now;
    }

    /// <summary>Records a worldsequence as applied and compacts contiguous ones into the high-water mark.</summary>
    private static void MarkApplied(Relationship rel, long worldsequence)
    {
        if (worldsequence <= rel.AppliedHighWater)
        {
            return;
        }

        if (!rel.RecentAppliedSequences.Contains(worldsequence))
        {
            rel.RecentAppliedSequences.Add(worldsequence);
        }

        // Compact: advance the high-water mark across any now-contiguous applied sequences.
        while (rel.RecentAppliedSequences.Remove(rel.AppliedHighWater + 1))
        {
            rel.AppliedHighWater++;
        }
    }
}
