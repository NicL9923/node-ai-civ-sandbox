using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Common;
using WorldMap.Core.Configuration;
using WorldMap.Core.Contracts;
using WorldMap.Core.Domain;
using WorldMap.Core.Sequencing;

namespace WorldMap.Core.Application.Impl;

/// <summary>
/// President-authorized inter-civ interactions (MVP: <c>contact</c> and <c>message</c>).
/// Submission is asynchronous: the World records the interaction, assigns a
/// <c>worldsequence</c>, updates the relationship deterministically, appends a public
/// world event, and queues a durable command for the target civ to pull — then returns
/// 202 Accepted. Idempotent by <c>Idempotency-Key</c>.
/// </summary>
public sealed class InteractionService(
    ICivilizationRepository civilizations,
    IInteractionRepository interactions,
    ICommandRepository commands,
    IWorldEventRepository worldEvents,
    IRelationshipRepository relationships,
    IIdempotencyStore idempotency,
    ISequenceAllocator sequence,
    TimeProvider clock,
    IOptions<WorldMapOptions> options,
    ILogger<InteractionService> logger) : IInteractionService
{
    private const string ContactKind = "contact";
    private const string MessageKind = "message";
    private const string ContactEventType = "world.civilization.contact.v1";
    private const string MessageEventType = "world.civilization.message.v1";
    private const string RelationshipOrdinalStream = "__relationship_ordinal";

    private readonly WorldMapOptions _options = options.Value;

    public async Task<Result<InteractionSubmitResult>> SubmitAsync(
        string authenticatedCivId,
        InteractionRequestDto request,
        string idempotencyKey,
        CancellationToken ct)
    {
        var scope = $"interactions:{authenticatedCivId}:{idempotencyKey}";
        var replay = await idempotency.GetAsync(scope, ct);
        if (replay is not null)
        {
            var original = JsonSerializer.Deserialize<AcceptedDto>(replay.ResponseJson, WorldMapJson.Options)!;
            return new InteractionSubmitResult(original with { Duplicate = true }, replay.Location ?? original.StatusUrl);
        }

        var validation = await ValidateAsync(authenticatedCivId, request, ct);
        if (validation is not null)
        {
            return validation;
        }

        var now = clock.GetUtcNow();
        var kind = request.Kind!;
        var source = request.Source!;
        var target = request.Target!;
        var sourceCiv = (await civilizations.GetAsync(source, ct))!;

        var interactionId = Ids.NewInteractionId();
        var correlationId = Ids.NewCorrelationId();

        var interaction = new Interaction
        {
            InteractionId = interactionId,
            Kind = kind,
            Source = source,
            Target = target,
            Status = InteractionStatus.Received,
            AuthorityDecision = request.AuthorityDecision,
            PublicNarrative = request.PublicNarrative,
            Payload = request.Payload?.DeepClone(),
            Public = true,
            CorrelationId = correlationId,
            CreatedAt = now,
            UpdatedAt = now,
            ExpiresAt = request.ExpiresAt,
        };

        // Authorize (the World records but does not adjudicate the civ's constitution).
        interaction.Authorize(now);

        // Assign the total-order worldsequence and order into the ledger.
        var worldsequence = await sequence.NextWorldSequenceAsync(ct);
        interaction.AssignSequence(worldsequence, now);

        // Deterministically create/update the relationship projection.
        await UpdateRelationshipAsync(kind, source, target, sourceCiv.DisplayName, request, now, ct);

        // Build the command payload + envelope for the target to pull.
        var commandData = BuildCommandData(kind, interactionId, sourceCiv, request);
        var commandId = Ids.NewCommandId();
        var commandSequence = await sequence.NextCommandSequenceAsync(target, ct);
        var eventType = kind == ContactKind ? ContactEventType : MessageEventType;

        await commands.AddAsync(new Command
        {
            CommandId = commandId,
            TargetCivId = target,
            CommandSequence = commandSequence,
            Worldsequence = worldsequence,
            EventId = Ids.NewWorldEventId(),
            Type = eventType,
            Source = $"/civilizations/{source}",
            Subject = target,
            Time = now,
            Data = commandData,
            CorrelationId = correlationId,
            CausationId = interactionId,
            IdempotencyKey = $"cmd:{interactionId}",
            DeliveredAt = now,
            ExpiresAt = interaction.ExpiresAt ?? now.AddSeconds(_options.Interaction.CommandTtlSeconds),
            InteractionId = interactionId,
            CreatedAt = now,
        }, ct);

        interaction.Queue(commandId, now);
        await interactions.AddAsync(interaction, ct);

        // Append the interaction to the public world-event feed (same worldsequence).
        await worldEvents.AddAsync(new WorldEvent
        {
            EventId = Ids.NewWorldEventId(),
            Worldsequence = worldsequence,
            Type = eventType,
            Source = $"/civilizations/{source}",
            Subject = target,
            Time = now,
            Datacontenttype = "application/json",
            Data = commandData.DeepClone(),
            CorrelationId = correlationId,
            CausationId = interactionId,
            SourceCiv = source,
            DedupeKey = $"interaction:{interactionId}",
            CreatedAt = now,
        }, ct);

        var statusUrl = $"{_options.WorldBaseUrl}/interactions/{interactionId}";
        var accepted = new AcceptedDto
        {
            Status = "accepted",
            ResourceId = interactionId,
            StatusUrl = statusUrl,
            Duplicate = false,
        };

        await idempotency.PutIfAbsentAsync(new IdempotencyRecord
        {
            Scope = scope,
            ResponseJson = JsonSerializer.Serialize(accepted, WorldMapJson.Options),
            StatusCode = 202,
            Location = statusUrl,
            CreatedAt = now,
            ExpiresAt = now.AddSeconds(_options.Interaction.IdempotencyTtlSeconds),
        }, ct);

        logger.LogInformation("Interaction {InteractionId} ({Kind}) queued: {Source} -> {Target}, worldsequence {Ws}.",
            interactionId, kind, source, target, worldsequence);

        return new InteractionSubmitResult(accepted, statusUrl);
    }

    public async Task<Result<InteractionDto>> GetAsync(string interactionId, CancellationToken ct)
    {
        var interaction = await interactions.GetAsync(interactionId, ct);
        return interaction is null
            ? ErrorResult.Create(ErrorCode.InteractionNotFound, $"Interaction '{interactionId}' not found.")
            : interaction.ToDto();
    }

    private async Task<ErrorInfo?> ValidateAsync(string authenticatedCivId, InteractionRequestDto request, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.Kind) || (request.Kind != ContactKind && request.Kind != MessageKind))
        {
            return ErrorResult.Create(ErrorCode.ValidationFailed, "kind must be 'contact' or 'message' (MVP).",
                errors: [new FieldError("/kind", "Only 'contact' and 'message' are supported.")]);
        }

        if (string.IsNullOrWhiteSpace(request.Source) || string.IsNullOrWhiteSpace(request.Target))
        {
            return ErrorResult.Create(ErrorCode.ValidationFailed, "source and target are required.");
        }

        if (request.Source != authenticatedCivId)
        {
            return ErrorResult.Create(ErrorCode.CivIdMismatch, "source must match the authenticated civilization.");
        }

        if (request.Target == request.Source)
        {
            return ErrorResult.Create(ErrorCode.ValidationFailed, "target must differ from source.");
        }

        if (request.AuthorityDecision is null || string.IsNullOrWhiteSpace(request.AuthorityDecision.Mode))
        {
            return ErrorResult.Create(ErrorCode.ValidationFailed, "authorityDecision.mode is required.",
                errors: [new FieldError("/authorityDecision", "authorityDecision is required.")]);
        }

        if (await civilizations.GetAsync(request.Target, ct) is null)
        {
            return ErrorResult.Create(ErrorCode.CivilizationNotFound, $"Target civilization '{request.Target}' not found.");
        }

        // Kind-specific payload validation.
        if (request.Kind == ContactKind)
        {
            var contact = Deserialize<ContactIntentDataDto>(request.Payload);
            if (contact is null || string.IsNullOrWhiteSpace(contact.Greeting))
            {
                return ErrorResult.Create(ErrorCode.ValidationFailed, "contact payload requires a greeting.",
                    errors: [new FieldError("/payload/greeting", "greeting is required for contact.")]);
            }
        }
        else
        {
            var message = Deserialize<MessageIntentDataDto>(request.Payload);
            if (message is null || string.IsNullOrWhiteSpace(message.Body))
            {
                return ErrorResult.Create(ErrorCode.ValidationFailed, "message payload requires a body.",
                    errors: [new FieldError("/payload/body", "body is required for message.")]);
            }
        }

        return null;
    }

    private async Task UpdateRelationshipAsync(
        string kind,
        string source,
        string target,
        string sourceDisplayName,
        InteractionRequestDto request,
        DateTimeOffset now,
        CancellationToken ct)
    {
        var pairKey = Relationship.PairKeyFor(source, target);
        var relationship = await relationships.GetAsync(pairKey, ct);
        if (relationship is null)
        {
            var ordinal = await sequence.NextCommandSequenceAsync(RelationshipOrdinalStream, ct);
            relationship = Relationship.CreateNeutral(source, target, ordinal, now);
        }

        if (kind == ContactKind)
        {
            RelationshipMath.ApplyContact(relationship, now);
        }
        else
        {
            var subject = Deserialize<MessageIntentDataDto>(request.Payload)?.Subject;
            RelationshipMath.ApplyMessage(relationship, sourceDisplayName, subject, now);
        }

        await relationships.UpsertAsync(relationship, ct);
    }

    private static JsonNode BuildCommandData(string kind, string interactionId, Domain.Civilization sourceCiv, InteractionRequestDto request)
    {
        if (kind == ContactKind)
        {
            var intent = Deserialize<ContactIntentDataDto>(request.Payload);
            var data = new ContactCommandDataDto
            {
                InteractionId = interactionId,
                FromCiv = sourceCiv.CivId,
                FromDisplayName = sourceCiv.DisplayName,
                Greeting = intent?.Greeting,
                PublicNarrative = request.PublicNarrative,
            };
            return JsonSerializer.SerializeToNode(data, WorldMapJson.Options)!;
        }
        else
        {
            var intent = Deserialize<MessageIntentDataDto>(request.Payload);
            var data = new MessageCommandDataDto
            {
                InteractionId = interactionId,
                FromCiv = sourceCiv.CivId,
                FromDisplayName = sourceCiv.DisplayName,
                Subject = intent?.Subject,
                Body = intent?.Body ?? string.Empty,
                InReplyTo = intent?.InReplyTo,
            };
            return JsonSerializer.SerializeToNode(data, WorldMapJson.Options)!;
        }
    }

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
