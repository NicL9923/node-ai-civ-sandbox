using WorldMap.Core.Common;
using WorldMap.Core.Contracts;
using WorldMap.Core.Domain;

namespace WorldMap.Core.Application;

/// <summary>
/// World-owned canonical authorization for social mutations. The World resolves canonical
/// civ/kind/local-agent identity from the account record and NEVER trusts caller-supplied actor/display
/// data. Validates civ ownership, agent/official actor binding against the latest synced authority, and
/// rejects World-only system accounts. The World does not adjudicate the civ's internal constitution.
/// </summary>
public static class SocialAuthorization
{
    /// <summary>
    /// Authorizes a mutation acting as <paramref name="account"/>. Returns the account on success, else
    /// the mapped social error (<c>social_account_not_found</c>, <c>system_account_reserved</c>,
    /// <c>forbidden_account</c>, <c>forbidden_actor</c>, <c>official_account_conflict</c>).
    /// </summary>
    public static Result<SocialAccount> Authorize(
        SocialAccount? account,
        string accountId,
        string authenticatedCivId,
        SocialMutationAuthorizationDto authorization)
    {
        if (account is null)
        {
            return ErrorResult.Create(ErrorCode.SocialAccountNotFound, $"Social account '{accountId}' is unknown.");
        }

        // A civ may never drive a World-only system account.
        if (string.Equals(account.Kind, SocialAccountKind.System, StringComparison.Ordinal))
        {
            return ErrorResult.Create(ErrorCode.SystemAccountReserved, "System accounts are reserved for the World.");
        }

        // The authenticated civ must own the acting account.
        if (!string.Equals(account.CivId, authenticatedCivId, StringComparison.Ordinal))
        {
            return ErrorResult.Create(ErrorCode.ForbiddenAccount,
                "The authenticated civilization does not own this account.");
        }

        // The acting local agent must match the account's authority.
        if (string.Equals(account.Kind, SocialAccountKind.Official, StringComparison.Ordinal))
        {
            var authority = account.OfficialAuthority;
            if (authority is null)
            {
                return ErrorResult.Create(ErrorCode.OfficialAccountConflict,
                    "The official account has no recorded President authority.");
            }

            if (!string.Equals(authorization.ActingLocalAgentId, authority.PresidentLocalAgentId, StringComparison.Ordinal))
            {
                return ErrorResult.Create(ErrorCode.ForbiddenActor,
                    "The acting local agent is not the current President of this official account.");
            }

            if (authorization.OfficialTermNumber is null || authorization.OfficialTermNumber.Value != authority.TermNumber)
            {
                return ErrorResult.Create(ErrorCode.OfficialAccountConflict,
                    "The official term number does not match the latest synced President term.");
            }
        }
        else
        {
            // Agent account: the acting local id must equal the account's own local id.
            if (!string.Equals(authorization.ActingLocalAgentId, account.LocalAgentId, StringComparison.Ordinal))
            {
                return ErrorResult.Create(ErrorCode.ForbiddenActor,
                    "The acting local agent does not match this account's identity.");
            }
        }

        // The civ-scoped authority decision reference is required for every account-acting mutation.
        if (string.IsNullOrEmpty(authorization.AuthorityDecision?.Ref))
        {
            return ErrorResult.Create(ErrorCode.ValidationFailed,
                "authorization.authorityDecision.ref is required.",
                errors: [new FieldError("/authorization/authorityDecision/ref", "ref is required.")]);
        }

        return account;
    }
}
