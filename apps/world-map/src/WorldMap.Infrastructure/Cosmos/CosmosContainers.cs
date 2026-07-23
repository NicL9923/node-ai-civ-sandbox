using System.Security.Cryptography;
using System.Text;

namespace WorldMap.Infrastructure.Cosmos;

/// <summary>Container names and shared partition-key conventions for the <c>worldmap</c> database.</summary>
internal static class CosmosContainers
{
    public const string Civilizations = "civilizations";
    public const string Credentials = "credentials";
    public const string Interactions = "interactions";
    public const string Commands = "commands";
    public const string WorldEvents = "worldEvents";
    public const string Relationships = "relationships";
    public const string Idempotency = "idempotency";
    public const string Nonces = "nonces";
    public const string Onboarding = "onboarding";

    /// <summary>Canonical World Wire accounts (PK = accountId).</summary>
    public const string SocialAccounts = "socialAccounts";

    /// <summary>Canonical World Wire posts (PK = conversationRootPostId).</summary>
    public const string SocialPosts = "socialPosts";

    /// <summary>Desired-state following edges (PK = followerAccountId).</summary>
    public const string SocialFollows = "socialFollows";

    /// <summary>Desired-state like edges (PK = postId).</summary>
    public const string SocialLikes = "socialLikes";

    /// <summary>World-sequence feed index rows (PK = feedScope: "global" or author accountId).</summary>
    public const string SocialFeed = "socialFeed";

    /// <summary>Durable following-feed snapshots (PK = ownerAccountId; TTL).</summary>
    public const string SocialSnapshots = "socialSnapshots";

    /// <summary>Per-account rate-limit state (PK = accountId; TTL).</summary>
    public const string SocialRateLimit = "socialRateLimit";

    /// <summary>Counter documents backing the atomic sequence/ordinal allocators (PK = stream name).</summary>
    public const string Sequences = "sequences";

    /// <summary>Single-writer lease lock document (id = PK = <c>world-writer</c>).</summary>
    public const string Lock = "lock";

    /// <summary>Uniform partition-key path used by every container (see <see cref="CosmosDoc{T}"/>).</summary>
    public const string PartitionKeyPath = "/pk";

    /// <summary>
    /// The public world-event ordinal path. A Cosmos <b>unique key</b> on this path (unique within the
    /// single <see cref="WorldEventFeedPartition"/> logical partition) makes a duplicate global
    /// <c>worldsequence</c> structurally impossible under ANY account consistency level — the durable
    /// backstop for the sequence allocator's ambiguous-commit recovery. Kept in lockstep with
    /// <c>infra/world/containers.json</c> (<c>uniqueKeyPaths</c>) by <c>scripts/check-world-infra.mjs</c>.
    /// </summary>
    public const string WorldEventSequencePath = "/payload/worldsequence";

    /// <summary>Per-container Cosmos unique-key policy paths (empty ⇒ no unique key).</summary>
    public static readonly IReadOnlyDictionary<string, IReadOnlyList<string>> UniqueKeyPaths =
        new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal)
        {
            [WorldEvents] = [WorldEventSequencePath],
        };

    /// <summary>
    /// Returns the required unique-key paths for <paramref name="name"/> that are absent from
    /// <paramref name="actualPaths"/> (the container's live policy). Empty ⇒ compliant (either the
    /// container requires no unique key, or every required path is present). Pure, so the readiness
    /// fail-closed decision is testable without a live Cosmos account.
    /// </summary>
    public static IReadOnlyList<string> MissingUniqueKeyPaths(string name, IEnumerable<string> actualPaths)
    {
        if (!UniqueKeyPaths.TryGetValue(name, out var required))
        {
            return [];
        }

        var actual = new HashSet<string>(actualPaths, StringComparer.Ordinal);
        return required.Where(p => !actual.Contains(p)).ToList();
    }

    /// <summary>
    /// True when the container's live unique-key policy satisfies the required <b>standalone</b> unique key
    /// for <paramref name="name"/>: some unique key's path SET equals the required set EXACTLY. A composite
    /// key with extra paths (e.g. <c>[/payload/worldsequence, /other]</c>) does NOT satisfy it — it only
    /// makes the COMBINATION unique, so it would not uniquely constrain the ordinal on its own. Containers
    /// with no declared requirement are always compliant. Pure ⇒ testable without a live Cosmos account.
    /// </summary>
    public static bool HasRequiredUniqueKey(string name, IEnumerable<IEnumerable<string>> actualUniqueKeys)
    {
        if (!UniqueKeyPaths.TryGetValue(name, out var required))
        {
            return true;
        }

        var requiredSet = new HashSet<string>(required, StringComparer.Ordinal);
        return actualUniqueKeys.Any(key => new HashSet<string>(key, StringComparer.Ordinal).SetEquals(requiredSet));
    }

    /// <summary>
    /// The single logical partition backing the ordered public event feed. This intentionally
    /// concentrates all world events in one partition to preserve global ordering for the MVP;
    /// it is a known hot-partition tradeoff to revisit at scale (e.g. time-bucketed partitions).
    /// </summary>
    public const string WorldEventFeedPartition = "public";

    /// <summary>Containers that enable time-to-live (per-item <c>ttl</c> drives expiry).</summary>
    public static readonly IReadOnlyList<string> TtlContainers = [Nonces, Idempotency, SocialSnapshots, SocialRateLimit];

    /// <summary>Every container the runtime requires to exist (validated by the readiness probe).</summary>
    public static readonly IReadOnlyList<string> All =
    [
        Civilizations,
        Credentials,
        Interactions,
        Commands,
        WorldEvents,
        Relationships,
        Idempotency,
        Nonces,
        Onboarding,
        SocialAccounts,
        SocialPosts,
        SocialFollows,
        SocialLikes,
        SocialFeed,
        SocialSnapshots,
        SocialRateLimit,
        Sequences,
        Lock,
    ];
}

/// <summary>
/// Derives Cosmos-safe document ids. Cosmos ids may not contain <c>/ \ # ?</c> and are length
/// bounded, so free-form keys (nonces, idempotency scopes, onboarding tokens) are hashed to hex.
/// </summary>
internal static class CosmosId
{
    public static string Hash(string value)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }
}
