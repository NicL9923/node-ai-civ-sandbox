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
/// under an idempotency claim scoped by <c>register:{tokenHash}</c> — anchored to the token hash and
/// independent of the caller's HTTP <c>Idempotency-Key</c>, with a fingerprint of the registration
/// profile (the raw token is excluded). The token is not "burned" on a downstream failure — a retry
/// with the same token resumes; a different profile for the same token is a registration conflict and
/// never mutates the civ. The World never mints, stores, or returns the HMAC secret.
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

        // Idempotency + reservation are anchored to the token HASH, independent of the caller's HTTP
        // Idempotency-Key. The fingerprint covers the canonical registration fields only (the raw token
        // is excluded), so the same token with the same profile replays and a different profile conflicts.
        var scope = $"register:{tokenHash}";
        var fingerprint = RequestFingerprint.Of(request with { OnboardingToken = null });
        var ttl = TimeSpan.FromSeconds(_options.Interaction.IdempotencyTtlSeconds);

        var outcome = await idempotency.ExecuteAsync<RegistrationResponseDto>(
            scope,
            fingerprint,
            ttl,
            innerCt => FinalizeAsync(record, request, fingerprint, innerCt),
            body => body with { Duplicate = true },
            ct,
            onConflict: RegistrationConflict);

        if (!outcome.IsSuccess)
        {
            return outcome.Error;
        }

        return new RegistrationResult(outcome.Value.Body, outcome.Value.Location ?? BuildLocation(record.CivId));
    }

    private async Task<Result<OperationOutcome<RegistrationResponseDto>>> FinalizeAsync(
        ResolvedOnboardingRecord record,
        RegistrationRequestDto request,
        string fingerprint,
        CancellationToken ct)
    {
        // Durable registration ledger keyed by token hash: create-only, fingerprint-gated. A resumed
        // finalize with the same profile re-reserves (DuplicateMatch) without burning the token; a
        // different profile is a hard conflict; the civ is never mutated by a later registration.
        var reservation = await onboardingTokens.ReserveAsync(record.TokenHash, record.CivId, fingerprint, ct);
        if (reservation == OnboardingReservationOutcome.Conflict)
        {
            logger.LogInformation("Registration rejected: onboarding token already used for a different registration profile.");
            return RegistrationConflict();
        }

        var now = clock.GetUtcNow();
        var existing = await civilizations.GetAsync(record.CivId, ct);
        var duplicate = reservation == OnboardingReservationOutcome.DuplicateMatch;

        // A durable replay (post-idempotency-TTL) of an already-completed registration: return the
        // original result WITHOUT mutating the civ, unless a crash left it half-created (repair below).
        if (duplicate && existing is not null)
        {
            return new OperationOutcome<RegistrationResponseDto>(
                BuildResponse(record, existing.RegisteredAt, duplicate: true), 201, BuildLocation(record.CivId));
        }

        // Persist only the credential REFERENCE — never secret material. Create-if-absent.
        if (await credentials.GetAsync(record.CivId, ct) is null)
        {
            await credentials.UpsertAsync(new CivCredential
            {
                CivId = record.CivId,
                KeyId = record.KeyId,
                SecretRef = record.SecretRef,
                Active = true,
                CreatedAt = now,
            }, ct);
        }

        if (secretStore.GetSecret(record.SecretRef) is null)
        {
            logger.LogWarning("Onboarding record for {CivId} references a secretRef that does not resolve yet.", record.CivId);
        }

        // Create-only: never overwrite an existing civ with a later registration's fields.
        var registeredAt = existing?.RegisteredAt ?? now;
        if (existing is null)
        {
            await civilizations.UpsertAsync(new Civilization
            {
                CivId = record.CivId,
                KeyId = record.KeyId,
                DisplayName = request.DisplayName!,
                ProtocolVersion = _options.ProtocolVersion,
                Capabilities = request.Capabilities,
                RegisteredAt = now,
                CreatedAt = now,
                UpdatedAt = now,
                Ordinal = 0,
            }, ct);
        }

        var response = BuildResponse(record, registeredAt, duplicate);
        logger.LogInformation("Civilization {CivId} registered via provisioned onboarding record (duplicate={Duplicate}).", record.CivId, duplicate);
        return new OperationOutcome<RegistrationResponseDto>(response, 201, BuildLocation(record.CivId));
    }

    private RegistrationResponseDto BuildResponse(ResolvedOnboardingRecord record, DateTimeOffset registeredAt, bool duplicate) => new()
    {
        CivId = record.CivId,
        KeyId = record.KeyId,
        ProtocolVersion = _options.ProtocolVersion,
        WorldBaseUrl = _options.WorldBaseUrl,
        CommandsCursor = null,
        RegisteredAt = registeredAt,
        Duplicate = duplicate,
    };

    private static ErrorInfo RegistrationConflict() => ErrorResult.Create(
        ErrorCode.RegistrationConflict,
        "This onboarding token was already used to register a different civilization profile.");

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
