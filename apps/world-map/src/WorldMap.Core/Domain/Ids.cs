using WorldMap.Core.Common;

namespace WorldMap.Core.Domain;

/// <summary>
/// Identifier helpers for World-assigned resources. Identifiers that name durable/repairable
/// artifacts (interactions, their commands and events, correlation ids) are DETERMINISTIC — derived
/// from a stable operation key — so a resumed or replayed operation reuses the exact same identity
/// and never produces duplicate repair artifacts.
/// </summary>
public static class Ids
{
    public const string DefaultKeyIdValue = "key_01";

    public static string DefaultKeyId() => DefaultKeyIdValue;

    /// <summary>Deterministic interaction id derived from the idempotency scope (stable across retries).</summary>
    public static string InteractionId(string idempotencyScope) => Deterministic.Id("int_", "interaction", idempotencyScope);

    /// <summary>Deterministic correlation id for an interaction (stable across retries).</summary>
    public static string CorrelationId(string interactionId) => Deterministic.Id("corr_", "correlation", interactionId);
}
