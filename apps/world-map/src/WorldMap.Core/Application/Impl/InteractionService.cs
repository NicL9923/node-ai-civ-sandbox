using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Common;
using WorldMap.Core.Configuration;
using WorldMap.Core.Contracts;
using WorldMap.Core.Domain;

namespace WorldMap.Core.Application.Impl;

/// <summary>
/// President-authorized inter-civ interactions (MVP: <c>contact</c> and <c>message</c>). Submission
/// durably persists an <c>accepted</c> interaction and its idempotency claim BEFORE any downstream
/// effect, returns 202, then drives the resumable process manager (inline best-effort; the worker
/// resumes anything left incomplete). Reads are restricted to the interaction's source or target.
/// </summary>
public sealed class InteractionService(
    ICivilizationRepository civilizations,
    IInteractionRepository interactions,
    IInteractionProcessor processor,
    IdempotencyExecutor idempotency,
    TimeProvider clock,
    IOptions<WorldMapOptions> options,
    ILogger<InteractionService> logger) : IInteractionService
{
    private const string ContactKind = "contact";
    private const string MessageKind = "message";
    private readonly WorldMapOptions _options = options.Value;

    public async Task<Result<InteractionSubmitResult>> SubmitAsync(
        string authenticatedCivId,
        InteractionRequestDto request,
        string idempotencyKey,
        CancellationToken ct)
    {
        var validation = await ValidateAsync(authenticatedCivId, request, ct);
        if (validation is not null)
        {
            return validation;
        }

        var scope = $"interactions:{authenticatedCivId}:{idempotencyKey}";
        var fingerprint = RequestFingerprint.Of(request);
        var ttl = TimeSpan.FromSeconds(_options.Interaction.IdempotencyTtlSeconds);
        var interactionId = Ids.InteractionId(scope);

        var outcome = await idempotency.ExecuteAsync<AcceptedDto>(
            scope,
            fingerprint,
            ttl,
            innerCt => AcceptAsync(interactionId, request, innerCt),
            body => body with { Duplicate = true },
            ct);

        if (!outcome.IsSuccess)
        {
            return outcome.Error;
        }

        // Acceptance + idempotency claim are durable; drive processing (idempotent). A failure here
        // does not affect the already-durable 202 — the maintenance worker resumes incomplete work.
        try
        {
            await processor.ProcessAsync(interactionId, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "Inline processing of interaction {InteractionId} failed; worker will resume.", interactionId);
        }

        var location = outcome.Value.Location ?? outcome.Value.Body.StatusUrl;
        return new InteractionSubmitResult(outcome.Value.Body, location);
    }

    private async Task<Result<OperationOutcome<AcceptedDto>>> AcceptAsync(
        string interactionId,
        InteractionRequestDto request,
        CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        var statusUrl = $"{_options.WorldBaseUrl}/interactions/{interactionId}";

        var existing = await interactions.GetAsync(interactionId, ct);
        if (existing is null)
        {
            var effectiveExpiresAt = ComputeEffectiveExpiry(request.ExpiresAt, now);
            await interactions.AddAsync(new Interaction
            {
                InteractionId = interactionId,
                Kind = request.Kind!,
                Source = request.Source!,
                Target = request.Target!,
                Status = InteractionStatus.Received,
                Step = InteractionStep.Accepted,
                AuthorityDecision = request.AuthorityDecision,
                PublicNarrative = request.PublicNarrative,
                Payload = request.Payload?.DeepClone(),
                Public = true,
                CorrelationId = Ids.CorrelationId(interactionId),
                CommandId = Interaction.DeriveCommandId(interactionId),
                EventId = Interaction.DeriveEventId(interactionId),
                CreatedAt = now,
                UpdatedAt = now,
                EffectiveExpiresAt = effectiveExpiresAt,
                Version = 0,
            }, ct);

            logger.LogInformation("Interaction {InteractionId} ({Kind}) accepted: {Source} -> {Target}.",
                interactionId, request.Kind, request.Source, request.Target);
        }

        var accepted = new AcceptedDto
        {
            Status = "accepted",
            ResourceId = interactionId,
            StatusUrl = statusUrl,
            Duplicate = false,
        };

        return new OperationOutcome<AcceptedDto>(accepted, 202, statusUrl);
    }

    public async Task<Result<InteractionDto>> GetAsync(string requesterCivId, string interactionId, CancellationToken ct)
    {
        var interaction = await interactions.GetAsync(interactionId, ct);
        if (interaction is null)
        {
            return ErrorResult.Create(ErrorCode.InteractionNotFound, $"Interaction '{interactionId}' not found.");
        }

        // Only the source or target civ may read an interaction's status.
        if (requesterCivId != interaction.Source && requesterCivId != interaction.Target)
        {
            return ErrorResult.Create(ErrorCode.AccessDenied, "Only the source or target civilization may view this interaction.");
        }

        return interaction.ToDto();
    }

    private DateTimeOffset ComputeEffectiveExpiry(DateTimeOffset? requested, DateTimeOffset now)
    {
        var cap = now.AddSeconds(_options.Interaction.CommandTtlSeconds);
        return requested is { } r && r < cap ? r : cap;
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
