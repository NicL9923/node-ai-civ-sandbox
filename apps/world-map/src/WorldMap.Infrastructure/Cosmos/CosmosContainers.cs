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

    /// <summary>Counter documents backing the atomic sequence/ordinal allocators (PK = stream name).</summary>
    public const string Sequences = "sequences";

    /// <summary>Uniform partition-key path used by every container (see <see cref="CosmosDoc{T}"/>).</summary>
    public const string PartitionKeyPath = "/pk";

    /// <summary>
    /// The single logical partition backing the ordered public event feed. This intentionally
    /// concentrates all world events in one partition to preserve global ordering for the MVP;
    /// it is a known hot-partition tradeoff to revisit at scale (e.g. time-bucketed partitions).
    /// </summary>
    public const string WorldEventFeedPartition = "public";

    /// <summary>Containers that enable time-to-live (per-item <c>ttl</c> drives expiry).</summary>
    public static readonly IReadOnlyList<string> TtlContainers = [Nonces, Idempotency];

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
        Sequences,
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
