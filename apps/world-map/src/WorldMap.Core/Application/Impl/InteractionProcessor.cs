using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Contracts;
using WorldMap.Core.Domain;

namespace WorldMap.Core.Application.Impl;

/// <summary>
/// Drives a durable interaction through its idempotent, resumable processing steps:
/// authorize → append public world event (assigns worldsequence) → update relationship (guarded by
/// worldsequence) → enqueue command → mark queued. Every step is safe to replay, so an inline call
/// after acceptance and a worker resume after a crash converge on "queued exactly once". Persisted
/// interaction updates use optimistic concurrency; a losing writer reloads and continues.
/// </summary>
public sealed class InteractionProcessor(
    ICivilizationRepository civilizations,
    IInteractionRepository interactions,
    IWorldEventRepository worldEvents,
    IRelationshipRepository relationships,
    ICommandRepository commands,
    PublicEventFactory publicEvents,
    IWorldEventSink sink,
    TimeProvider clock,
    ILogger<InteractionProcessor> logger) : IInteractionProcessor
{
    private const string ContactKind = "contact";
    private const string ContactEventType = "world.civilization.contact.v1";
    private const string MessageEventType = "world.civilization.message.v1";
    private const int MaxConcurrencyRetries = 8;

    public async Task ProcessAsync(string interactionId, CancellationToken ct)
    {
        for (var attempt = 0; attempt < MaxConcurrencyRetries; attempt++)
        {
            var interaction = await interactions.GetAsync(interactionId, ct);
            if (interaction is null || interaction.IsProcessingComplete)
            {
                return;
            }

            if (await TryAdvanceAsync(interaction, ct))
            {
                if (interaction.IsProcessingComplete)
                {
                    return;
                }

                // Advanced a step; loop to persist/continue the next step.
                continue;
            }

            // Concurrency conflict — reload and retry.
        }

        logger.LogWarning("Interaction {InteractionId} did not complete processing within the retry budget; worker will resume.", interactionId);
    }

    /// <summary>Performs the next pending step and persists it. Returns false on a concurrency conflict.</summary>
    private async Task<bool> TryAdvanceAsync(Interaction interaction, CancellationToken ct)
    {
        var now = clock.GetUtcNow();

        switch (interaction.Step)
        {
            case InteractionStep.Accepted:
                interaction.MarkAuthorized(now);
                return await interactions.UpdateAsync(interaction, ct);

            case InteractionStep.Authorized:
            {
                var source = await civilizations.GetAsync(interaction.Source, ct);
                if (source is null)
                {
                    interaction.Reject(Problem("civ_not_found", "Source civilization no longer exists."), now);
                    return await interactions.UpdateAsync(interaction, ct);
                }

                var publicData = BuildPublicData(interaction, source.DisplayName);
                var appended = await worldEvents.AppendAsync(new WorldEvent
                {
                    EventId = interaction.EventId,
                    Type = EventType(interaction.Kind),
                    Source = $"/civilizations/{interaction.Source}",
                    Subject = interaction.Target,
                    Time = interaction.CreatedAt,
                    PublicData = publicData,
                    CorrelationId = interaction.CorrelationId,
                    CausationId = interaction.InteractionId,
                    SourceCiv = interaction.Source,
                    DedupeKey = $"interaction:{interaction.InteractionId}",
                    CreatedAt = now,
                }, ct);

                interaction.Worldsequence = appended.Event.Worldsequence;
                interaction.AdvanceStep(InteractionStep.EventAppended, now);
                if (!appended.WasDuplicate)
                {
                    sink.Publish(appended.Event.ToPublicDto());
                }

                return await interactions.UpdateAsync(interaction, ct);
            }

            case InteractionStep.EventAppended:
            {
                if (!await UpdateRelationshipAsync(interaction, ct))
                {
                    return false; // Relationship not committed yet; retry/resume without advancing.
                }

                interaction.AdvanceStep(InteractionStep.RelationshipUpdated, now);
                return await interactions.UpdateAsync(interaction, ct);
            }

            case InteractionStep.RelationshipUpdated:
            {
                var source = await civilizations.GetAsync(interaction.Source, ct);
                var data = BuildCommandData(interaction, source?.DisplayName ?? interaction.Source);
                await commands.EnqueueAsync(new Command
                {
                    CommandId = interaction.CommandId,
                    TargetCivId = interaction.Target,
                    Worldsequence = interaction.Worldsequence,
                    EventId = interaction.EventId,
                    Type = EventType(interaction.Kind),
                    Source = $"/civilizations/{interaction.Source}",
                    Subject = interaction.Target,
                    Time = interaction.CreatedAt,
                    Data = data,
                    CorrelationId = interaction.CorrelationId,
                    CausationId = interaction.InteractionId,
                    IdempotencyKey = $"cmd:{interaction.InteractionId}",
                    DeliveredAt = now,
                    ExpiresAt = interaction.EffectiveExpiresAt,
                    InteractionId = interaction.InteractionId,
                    CreatedAt = now,
                }, ct);

                interaction.AdvanceStep(InteractionStep.CommandQueued, now);
                return await interactions.UpdateAsync(interaction, ct);
            }

            case InteractionStep.CommandQueued:
                interaction.MarkQueued(now);
                return await interactions.UpdateAsync(interaction, ct);

            default:
                return true;
        }
    }

    private async Task<bool> UpdateRelationshipAsync(Interaction interaction, CancellationToken ct)
    {
        var worldsequence = interaction.Worldsequence ?? 0;
        var source = await civilizations.GetAsync(interaction.Source, ct);
        var displayName = source?.DisplayName ?? interaction.Source;
        var pairKey = Relationship.PairKeyFor(interaction.Source, interaction.Target);

        for (var attempt = 0; attempt < MaxConcurrencyRetries; attempt++)
        {
            var now = clock.GetUtcNow();
            var existing = await relationships.GetAsync(pairKey, ct);
            var relationship = existing ?? Relationship.CreateNeutral(interaction.Source, interaction.Target, now);

            // Guarded by worldsequence: a replay of the same interaction is a no-op.
            var changed = interaction.Kind == ContactKind
                ? RelationshipMath.ApplyContact(relationship, worldsequence, now)
                : RelationshipMath.ApplyMessage(relationship, worldsequence, displayName, MessageSubject(interaction), now);

            if (!changed && existing is not null)
            {
                return true; // Already applied — nothing to commit.
            }

            if (await relationships.TryUpsertAsync(relationship, ct))
            {
                return true;
            }

            // Concurrency conflict — reload and retry.
        }

        logger.LogWarning("Relationship update for interaction {InteractionId} exhausted retries; will resume.", interaction.InteractionId);
        return false;
    }

    private JsonNode? BuildPublicData(Interaction interaction, string fromDisplayName)
    {
        if (interaction.Kind == ContactKind)
        {
            return publicEvents.Contact(interaction.Source, fromDisplayName, interaction.PublicNarrative);
        }

        return publicEvents.Message(interaction.Source, fromDisplayName, MessageSubject(interaction), interaction.PublicNarrative);
    }

    private static JsonNode BuildCommandData(Interaction interaction, string fromDisplayName)
    {
        if (interaction.Kind == ContactKind)
        {
            var intent = Deserialize<ContactIntentDataDto>(interaction.Payload);
            return JsonSerializer.SerializeToNode(new ContactCommandDataDto
            {
                InteractionId = interaction.InteractionId,
                FromCiv = interaction.Source,
                FromDisplayName = fromDisplayName,
                Greeting = intent?.Greeting,
                PublicNarrative = interaction.PublicNarrative,
            }, WorldMapJson.Options)!;
        }

        var msg = Deserialize<MessageIntentDataDto>(interaction.Payload);
        return JsonSerializer.SerializeToNode(new MessageCommandDataDto
        {
            InteractionId = interaction.InteractionId,
            FromCiv = interaction.Source,
            FromDisplayName = fromDisplayName,
            Subject = msg?.Subject,
            Body = msg?.Body ?? string.Empty,
            InReplyTo = msg?.InReplyTo,
        }, WorldMapJson.Options)!;
    }

    private static string? MessageSubject(Interaction interaction) =>
        interaction.Kind == ContactKind ? null : Deserialize<MessageIntentDataDto>(interaction.Payload)?.Subject;

    private static string EventType(string kind) => kind == ContactKind ? ContactEventType : MessageEventType;

    private static JsonNode Problem(string code, string detail) => new JsonObject
    {
        ["type"] = "about:blank",
        ["title"] = "Interaction failed",
        ["status"] = 409,
        ["code"] = code,
        ["detail"] = detail,
        ["retryable"] = false,
    };

    private static T? Deserialize<T>(JsonNode? node) where T : class
    {
        if (node is null)
        {
            return null;
        }

        try
        {
            return node.Deserialize<T>(WorldMapJson.Options);
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
