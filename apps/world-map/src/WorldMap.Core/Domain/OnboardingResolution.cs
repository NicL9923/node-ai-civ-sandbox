namespace WorldMap.Core.Domain;

/// <summary>
/// A resolved onboarding binding derived from configuration at startup. Holds ONLY the token HASH
/// (never the raw token) alongside the fixed civ identity it provisions.
/// </summary>
public sealed record ResolvedOnboardingRecord(string TokenHash, string CivId, string KeyId, string SecretRef);
