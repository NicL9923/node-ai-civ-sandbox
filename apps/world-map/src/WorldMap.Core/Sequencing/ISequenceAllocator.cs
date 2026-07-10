namespace WorldMap.Core.Sequencing;

/// <summary>
/// Allocates the World's monotonic int64 total-order <c>worldsequence</c> and the
/// per-civ command sequence.
///
/// <para>
/// <b>Consistency:</b> allocation is monotonic and gap-tolerant on a <b>single</b> app
/// instance (the application layer assigns + persists under one critical section). This
/// is correct for the MVP single-instance deployment. <b>Scale-out (not implemented):</b>
/// move to a lease/block allocator (each instance reserves an id range) or a dedicated
/// sequence service / Cosmos atomic increment. We make no false distributed-atomicity
/// claims here.
/// </para>
/// </summary>
public interface ISequenceAllocator
{
    /// <summary>Returns the next global worldsequence value (strictly increasing).</summary>
    ValueTask<long> NextWorldSequenceAsync(CancellationToken ct);

    /// <summary>Returns the next per-civ command sequence value (strictly increasing per civ).</summary>
    ValueTask<long> NextCommandSequenceAsync(string civId, CancellationToken ct);
}
