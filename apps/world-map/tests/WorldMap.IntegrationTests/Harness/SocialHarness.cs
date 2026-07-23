using System.Net.Http.Json;
using WorldMap.Core.Contracts;

namespace WorldMap.IntegrationTests.Harness;

/// <summary>Builders for World Wire social request DTOs used across the social integration suite.</summary>
public static class SocialDtos
{
    public static SocialMutationAuthorizationDto AgentAuth(string localAgentId, string @ref = "social_intent") => new()
    {
        ActingLocalAgentId = localAgentId,
        AuthorityDecision = new AuthorityDecisionDto { Mode = "agent", Ref = @ref, AuthorizedAt = DateTimeOffset.UtcNow },
    };

    public static SocialMutationAuthorizationDto OfficialAuth(string presidentLocalId, int term, string @ref) => new()
    {
        ActingLocalAgentId = presidentLocalId,
        OfficialTermNumber = term,
        AuthorityDecision = new AuthorityDecisionDto { Mode = "president", Ref = @ref, AuthorizedAt = DateTimeOffset.UtcNow },
    };

    public static SocialAccountUpsertDto Agent(string civId, string localAgentId, string displayName, string? bio = null) => new()
    {
        Actor = new SocialActorRefDto { CivId = civId, LocalAgentId = localAgentId, DisplayName = displayName, Kind = "agent" },
        Bio = bio,
    };

    public static SocialAccountUpsertDto Official(string civId, string displayName, string presidentLocalId, int term, string @ref) => new()
    {
        Actor = new SocialActorRefDto { CivId = civId, DisplayName = displayName, Kind = "official" },
        OfficialAuthority = new SocialOfficialAuthorityDto
        {
            PresidentLocalAgentId = presidentLocalId,
            PresidentDisplayName = displayName,
            TermNumber = term,
            AuthorityDecision = new AuthorityDecisionDto { Mode = "president", Ref = @ref, AuthorizedAt = DateTimeOffset.UtcNow },
        },
    };

    public static SocialAccountSyncRequestDto Sync(string civId, params SocialAccountUpsertDto[] accounts) => new()
    {
        CivId = civId,
        Accounts = accounts.ToList(),
    };

    public static SocialPostCreateRequestDto Post(string authorAccountId, string text, string localAgentId, string? parentPostId = null) => new()
    {
        AuthorAccountId = authorAccountId,
        Text = text,
        ParentPostId = parentPostId,
        Authorization = AgentAuth(localAgentId),
    };

    public static SocialFollowSetRequestDto Follow(bool following, string localAgentId) => new()
    {
        Following = following,
        Authorization = AgentAuth(localAgentId),
    };

    public static SocialReactionSetRequestDto Like(bool liked, string localAgentId) => new()
    {
        Liked = liked,
        Authorization = AgentAuth(localAgentId),
    };

    public static SocialPostTombstoneRequestDto Tombstone(string localAgentId) => new()
    {
        Authorization = AgentAuth(localAgentId),
    };
}

/// <summary>Signed-request senders for the World Wire social mutation endpoints.</summary>
public static class SocialApi
{
    public static Task<HttpResponseMessage> SyncAsync(HttpClient client, CivContext civ, SocialAccountSyncRequestDto req, string key) =>
        SendAsync(client, civ, HttpMethod.Post, "/world/v1/social/accounts/sync", req, key);

    public static Task<HttpResponseMessage> CreatePostAsync(HttpClient client, CivContext civ, SocialPostCreateRequestDto req, string key) =>
        SendAsync(client, civ, HttpMethod.Post, "/world/v1/social/posts", req, key);

    public static Task<HttpResponseMessage> TombstoneAsync(HttpClient client, CivContext civ, string postId, SocialPostTombstoneRequestDto req, string key) =>
        SendAsync(client, civ, HttpMethod.Post, $"/world/v1/social/posts/{postId}/tombstone", req, key);

    public static Task<HttpResponseMessage> FollowAsync(HttpClient client, CivContext civ, string accountId, string targetAccountId, SocialFollowSetRequestDto req, string key) =>
        SendAsync(client, civ, HttpMethod.Put, $"/world/v1/social/accounts/{accountId}/following/{targetAccountId}", req, key);

    public static Task<HttpResponseMessage> LikeAsync(HttpClient client, CivContext civ, string postId, string accountId, SocialReactionSetRequestDto req, string key) =>
        SendAsync(client, civ, HttpMethod.Put, $"/world/v1/social/posts/{postId}/likes/{accountId}", req, key);

    private static async Task<HttpResponseMessage> SendAsync(HttpClient client, CivContext civ, HttpMethod method, string path, object dto, string key)
    {
        var body = Signing.SerializeBody(dto);
        using var request = Signing.BuildSignedRequest(method, path, string.Empty, body, civ.CivId, civ.KeyId, civ.Secret, idempotencyKey: key);
        return await client.SendAsync(request);
    }

    /// <summary>Syncs one agent account and returns its World-assigned account id.</summary>
    public static async Task<string> SyncAgentAsync(HttpClient client, CivContext civ, string localAgentId, string displayName)
    {
        var response = await SyncAsync(client, civ, SocialDtos.Sync(civ.CivId, SocialDtos.Agent(civ.CivId, localAgentId, displayName)), Guid.NewGuid().ToString("N"));
        response.EnsureSuccessStatusCode();
        var body = (await response.Content.ReadFromJsonAsync<SocialAccountSyncResponseDto>(WorldMapJson.Options))!;
        return body.Accounts[0].AccountId;
    }
}
