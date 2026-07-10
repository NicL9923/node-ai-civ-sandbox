using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Common;
using WorldMap.Core.Configuration;
using WorldMap.Core.Contracts;
using WorldMap.Core.Domain;

namespace WorldMap.Core.Application.Impl;

/// <summary>
/// Civilization onboarding. Resolves a presented token by HASH to a preprovisioned record, then
/// runs a resumable, idempotent finalize (reserve token → persist credential ref → persist civ)
/// under an idempotency claim scoped by <c>register:{tokenHash}:{idempotencyKey}</c>. The token is
/// not "burned" on a downstream failure — a retry with the same key resumes. The World never mints,
/// stores, or returns the HMAC secret.
/// </summary>
public sealed class OnboardingService(
    ICivilizationRepository civilizations,
    ICivCredentialRepository credentials,
    IOnboardingRegistry registry,
    IOnboardingTokenStore onboardingTokens,
    ISecretStore secretStore,
    IdempotencyExecutor idempotency,
    TimeProvider clock,
    IOptions<WorldMapOptions> options,
    ILogger<OnboardingService> logger) : IOnboardingService
{
    private readonly WorldMapOptions _options = options.Value;

    public async Task<Result<RegistrationResult>> RegisterAsync(
        RegistrationRequestDto request,
        string idempotencyKey,
        CancellationToken ct)
    {
        var validation = Validate(request);
        if (validation is not null)
        {
            return validation;
        }

        var tokenHash = Sha256Hex(request.OnboardingToken!);
        var record = registry.Resolve(tokenHash);
        if (record is null)
        {
            logger.LogInformation("Registration rejected: onboarding token did not resolve to a provisioned record.");
            return ErrorResult.Create(ErrorCode.RegistrationConflict, "The onboarding token is invalid or has already been used.");
        }

        var scope = $"register:{tokenHash}:{idempotencyKey}";
        var fingerprint = RequestFingerprint.Of(request);
        var ttl = TimeSpan.FromSeconds(_options.Interaction.IdempotencyTtlSeconds);

        var outcome = await idempotency.ExecuteAsync<RegistrationResponseDto>(
            scope,
            fingerprint,
            ttl,
            innerCt => FinalizeAsync(record, request, innerCt),
            body => body with { Duplicate = true },
            ct);

        if (!outcome.IsSuccess)
        {
            return outcome.Error;
        }

        return new RegistrationResult(outcome.Value.Body, outcome.Value.Location ?? BuildLocation(record.CivId));
    }

    private async Task<Result<OperationOutcome<RegistrationResponseDto>>> FinalizeAsync(
        ResolvedOnboardingRecord record,
        RegistrationRequestDto request,
        CancellationToken ct)
    {
        // Reserve the token by hash. Idempotent for the same civ, so a resumed finalize re-reserves
        // without burning the token; a reservation by a different civ is impossible (fixed mapping).
        if (!await onboardingTokens.TryReserveAsync(record.TokenHash, record.CivId, ct))
        {
            logger.LogInformation("Registration rejected: token already reserved for a different civ.");
            return ErrorResult.Create(ErrorCode.RegistrationConflict, "The onboarding token is invalid or has already been used.");
        }

        var now = clock.GetUtcNow();

        // Persist only the credential reference — never secret material.
        await credentials.UpsertAsync(new CivCredential
        {
            CivId = record.CivId,
            KeyId = record.KeyId,
            SecretRef = record.SecretRef,
            Active = true,
            CreatedAt = now,
        }, ct);

        if (secretStore.GetSecret(record.SecretRef) is null)
        {
            logger.LogWarning("Onboarding record for {CivId} references a secretRef that does not resolve yet.", record.CivId);
        }

        var existing = await civilizations.GetAsync(record.CivId, ct);
        await civilizations.UpsertAsync(new Civilization
        {
            CivId = record.CivId,
            KeyId = record.KeyId,
            DisplayName = request.DisplayName!,
            ProtocolVersion = _options.ProtocolVersion,
            Capabilities = request.Capabilities,
            RegisteredAt = existing?.RegisteredAt ?? now,
            CreatedAt = existing?.CreatedAt ?? now,
            UpdatedAt = now,
            Ordinal = existing?.Ordinal ?? 0,
        }, ct);

        var response = new RegistrationResponseDto
        {
            CivId = record.CivId,
            KeyId = record.KeyId,
            ProtocolVersion = _options.ProtocolVersion,
            WorldBaseUrl = _options.WorldBaseUrl,
            CommandsCursor = null,
            RegisteredAt = existing?.RegisteredAt ?? now,
            Duplicate = false,
        };

        logger.LogInformation("Civilization {CivId} registered via provisioned onboarding record.", record.CivId);
        return new OperationOutcome<RegistrationResponseDto>(response, 201, BuildLocation(record.CivId));
    }

    private static string Sha256Hex(string value) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private static ErrorInfo? Validate(RegistrationRequestDto request)
    {
        var errors = new List<FieldError>();
        if (string.IsNullOrWhiteSpace(request.OnboardingToken))
        {
            errors.Add(new FieldError("/onboardingToken", "onboardingToken is required."));
        }

        if (string.IsNullOrWhiteSpace(request.DisplayName) || request.DisplayName.Length > 120)
        {
            errors.Add(new FieldError("/displayName", "displayName is required and must be 1..120 characters."));
        }

        if (request.Capabilities is null || string.IsNullOrWhiteSpace(request.Capabilities.ProtocolVersion))
        {
            errors.Add(new FieldError("/capabilities", "capabilities.protocolVersion and supportedInteractionKinds are required."));
        }

        return errors.Count > 0
            ? ErrorResult.Create(ErrorCode.ValidationFailed, "Registration request failed validation.", errors: errors)
            : null;
    }

    private string BuildLocation(string civId) => $"{_options.WorldBaseUrl}/civilizations/{civId}";
}
