using WorldMap.Core.Domain;

namespace WorldMap.Core.Abstractions;

/// <summary>
/// Resolves a presented onboarding token (by its SHA-256 hash) to its preprovisioned binding. Built
/// once at startup from configuration; holds only token hashes, never raw tokens.
/// </summary>
public interface IOnboardingRegistry
{
    /// <summary>Resolves a token hash to its record, or null if no such binding exists.</summary>
    ResolvedOnboardingRecord? Resolve(string tokenHash);
}
