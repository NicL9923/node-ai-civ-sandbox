using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
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
/// Civilization onboarding. Consumes an operator-preprovisioned onboarding record
/// (token -&gt; civId/keyId/secretRef); the World binds the civilization to that fixed
/// identity and persists only the <c>secretRef</c> — it never mints, stores, or returns
/// the HMAC secret (the civ receives its secret out-of-band; the runtime resolves it via
/// <c>ISecretStore</c>). Idempotent by <c>Idempotency-Key</c>: a replay returns the original
/// result.
/// </summary>
public sealed class OnboardingService(
    ICivilizationRepository civilizations,
    ICivCredentialRepository credentials,
    IOnboardingTokenStore onboardingTokens,
    ISecretStore secretStore,
    IIdempotencyStore idempotency,
    ISequenceAllocator sequence,
    TimeProvider clock,
    IOptions<WorldMapOptions> options,
    ILogger<OnboardingService> logger) : IOnboardingService
{
    private const string CivOrdinalStream = "__civ_ordinal";
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

        var scope = $"register::{idempotencyKey}";
        var replay = await idempotency.GetAsync(scope, ct);
        if (replay is not null)
        {
            var original = JsonSerializer.Deserialize<RegistrationResponseDto>(replay.ResponseJson, WorldMapJson.Options)!;
            return new RegistrationResult(original with { Duplicate = true }, replay.Location ?? BuildLocation(original.CivId));
        }

        var record = FindOnboardingRecord(request.OnboardingToken!);
        if (record is null)
        {
            logger.LogInformation("Registration rejected: onboarding token did not match any provisioned record.");
            return ErrorResult.Create(ErrorCode.RegistrationConflict, "The onboarding token is invalid or has already been used.");
        }

        // Atomically consume the token so it binds at most one civilization.
        if (!await onboardingTokens.TryConsumeAsync(record.Token, record.CivId, ct))
        {
            logger.LogInformation("Registration rejected: onboarding token already consumed for {CivId}.", record.CivId);
            return ErrorResult.Create(ErrorCode.RegistrationConflict, "The onboarding token is invalid or has already been used.");
        }

        var now = clock.GetUtcNow();

        // Persist only the credential reference — no secret material is stored here.
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
            // Not fatal: the civ simply cannot authenticate until the secret is provisioned.
            logger.LogWarning("Onboarding record for {CivId} references secretRef '{SecretRef}' which does not resolve yet.",
                record.CivId, record.SecretRef);
        }

        var ordinal = await sequence.NextCommandSequenceAsync(CivOrdinalStream, ct);
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
            Ordinal = ordinal,
        }, ct);

        var response = new RegistrationResponseDto
        {
            CivId = record.CivId,
            KeyId = record.KeyId,
            ProtocolVersion = _options.ProtocolVersion,
            WorldBaseUrl = _options.WorldBaseUrl,
            CommandsCursor = null,
            RegisteredAt = now,
            Duplicate = false,
        };
        var location = BuildLocation(record.CivId);

        await idempotency.PutIfAbsentAsync(new IdempotencyRecord
        {
            Scope = scope,
            ResponseJson = JsonSerializer.Serialize(response, WorldMapJson.Options),
            StatusCode = 201,
            Location = location,
            CreatedAt = now,
            ExpiresAt = now.AddSeconds(_options.Interaction.IdempotencyTtlSeconds),
        }, ct);

        logger.LogInformation("Civilization {CivId} registered via provisioned onboarding record.", record.CivId);
        return new RegistrationResult(response, location);
    }

    private OnboardingRecord? FindOnboardingRecord(string presentedToken)
    {
        // Constant-time hash comparison so registration does not leak token contents via timing.
        var presentedHash = Sha256(presentedToken);
        foreach (var record in _options.Onboarding.Records)
        {
            if (string.IsNullOrEmpty(record.Token) || string.IsNullOrEmpty(record.CivId) || string.IsNullOrEmpty(record.SecretRef))
            {
                continue;
            }

            if (CryptographicOperations.FixedTimeEquals(presentedHash, Sha256(record.Token)))
            {
                return record;
            }
        }

        return null;
    }

    private static byte[] Sha256(string value) => SHA256.HashData(Encoding.UTF8.GetBytes(value));

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
