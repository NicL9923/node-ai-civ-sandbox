using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using WorldMap.Api.Middleware;
using WorldMap.Api.Results;
using WorldMap.Api.Telemetry;
using WorldMap.Core.Application;
using WorldMap.Core.Common;
using WorldMap.Core.Contracts;

namespace WorldMap.Api.Endpoints;

/// <summary>
/// World Wire social endpoints under <c>/world/v1/social</c>. Mutations are HMAC-signed and idempotent;
/// reads are public/unsigned. The World resolves canonical account identity from its records and never
/// trusts caller-supplied actor/display data.
/// </summary>
internal static class SocialEndpoints
{
    public static void MapSocialEndpoints(this RouteGroupBuilder group)
    {
        // --- Account sync (HMAC + idempotency) ---
        group.MapPost("/social/accounts/sync", async (
            SocialAccountSyncRequestDto request,
            HttpContext http,
            ISocialAccountService accountsService,
            WorldMapMetrics metrics,
            CancellationToken ct) =>
        {
            var auth = EndpointHelpers.Auth(http);
            if (EndpointHelpers.RequireIdempotencyKey(http, auth.IdempotencyKey) is { } bad)
            {
                return bad;
            }

            var result = await accountsService.SyncAsync(auth.CivId, request, auth.IdempotencyKey, ct);
            return Mutation(result, http, metrics, "sync");
        })
        .AddEndpointFilter<HmacAuthEndpointFilter>()
        .WithName("syncSocialAccounts")
        .WithTags("social");

        // --- Public account reads ---
        group.MapGet("/social/accounts/{accountId}", async (
            string accountId, HttpContext http, ISocialAccountService accountsService, CancellationToken ct) =>
            ApiResults.Ok(await accountsService.GetAsync(accountId, ct), http))
            .WithName("getSocialAccount").WithTags("social");

        group.MapGet("/social/accounts/{accountId}/posts", async (
            string accountId, string? cursor, int? limit, HttpContext http, ISocialFeedService feed, CancellationToken ct) =>
            ApiResults.Ok(await feed.AccountPostsAsync(accountId, cursor, limit, ct), http))
            .WithName("listSocialAccountPosts").WithTags("social");

        group.MapGet("/social/accounts/{accountId}/feed", async (
            string accountId, string? cursor, int? limit, HttpContext http, ISocialFeedService feed, CancellationToken ct) =>
            ApiResults.Ok(await feed.FollowingFeedAsync(accountId, cursor, limit, ct), http))
            .WithName("listSocialFollowingFeed").WithTags("social");

        group.MapGet("/social/accounts/{accountId}/followers", async (
            string accountId, string? cursor, int? limit, HttpContext http, ISocialAccountService accountsService, CancellationToken ct) =>
            ApiResults.Ok(await accountsService.ListFollowersAsync(accountId, cursor, limit, ct), http))
            .WithName("listSocialFollowers").WithTags("social");

        group.MapGet("/social/accounts/{accountId}/following", async (
            string accountId, string? cursor, int? limit, HttpContext http, ISocialAccountService accountsService, CancellationToken ct) =>
            ApiResults.Ok(await accountsService.ListFollowingAsync(accountId, cursor, limit, ct), http))
            .WithName("listSocialFollowing").WithTags("social");

        // --- Follow (HMAC + idempotency) ---
        group.MapPut("/social/accounts/{accountId}/following/{targetAccountId}", async (
            string accountId,
            string targetAccountId,
            SocialFollowSetRequestDto request,
            HttpContext http,
            ISocialGraphService graph,
            WorldMapMetrics metrics,
            CancellationToken ct) =>
        {
            var auth = EndpointHelpers.Auth(http);
            if (EndpointHelpers.RequireIdempotencyKey(http, auth.IdempotencyKey) is { } bad)
            {
                return bad;
            }

            var result = await graph.SetFollowAsync(auth.CivId, accountId, targetAccountId, request, auth.IdempotencyKey, ct);
            return Mutation(result, http, metrics, "follow");
        })
        .AddEndpointFilter<HmacAuthEndpointFilter>()
        .WithName("setSocialFollow")
        .WithTags("social");

        // --- Global feed (public) ---
        group.MapGet("/social/feed", async (
            string? cursor, int? limit, HttpContext http, ISocialFeedService feed, CancellationToken ct) =>
            ApiResults.Ok(await feed.GlobalAsync(cursor, limit, ct), http))
            .WithName("listSocialGlobalFeed").WithTags("social");

        // --- Post create (HMAC + idempotency) ---
        group.MapPost("/social/posts", async (
            SocialPostCreateRequestDto request,
            HttpContext http,
            ISocialPostService postsService,
            WorldMapMetrics metrics,
            CancellationToken ct) =>
        {
            var auth = EndpointHelpers.Auth(http);
            if (EndpointHelpers.RequireIdempotencyKey(http, auth.IdempotencyKey) is { } bad)
            {
                return bad;
            }

            var result = await postsService.CreateAsync(auth.CivId, request, auth.IdempotencyKey, ct);
            return Mutation(result, http, metrics, "post");
        })
        .AddEndpointFilter<HmacAuthEndpointFilter>()
        .WithName("createSocialPost")
        .WithTags("social");

        // --- Public post reads ---
        group.MapGet("/social/posts/{postId}", async (
            string postId, HttpContext http, ISocialPostService postsService, CancellationToken ct) =>
            ApiResults.Ok(await postsService.GetAsync(postId, ct), http))
            .WithName("getSocialPost").WithTags("social");

        group.MapGet("/social/posts/{postId}/thread", async (
            string postId, string? cursor, int? limit, HttpContext http, ISocialPostService postsService, CancellationToken ct) =>
            ApiResults.Ok(await postsService.GetThreadAsync(postId, cursor, limit, ct), http))
            .WithName("getSocialThread").WithTags("social");

        // --- Tombstone (HMAC + idempotency) ---
        group.MapPost("/social/posts/{postId}/tombstone", async (
            string postId,
            SocialPostTombstoneRequestDto request,
            HttpContext http,
            ISocialPostService postsService,
            WorldMapMetrics metrics,
            CancellationToken ct) =>
        {
            var auth = EndpointHelpers.Auth(http);
            if (EndpointHelpers.RequireIdempotencyKey(http, auth.IdempotencyKey) is { } bad)
            {
                return bad;
            }

            var result = await postsService.TombstoneAsync(auth.CivId, postId, request, auth.IdempotencyKey, ct);
            return Mutation(result, http, metrics, "tombstone");
        })
        .AddEndpointFilter<HmacAuthEndpointFilter>()
        .WithName("tombstoneSocialPost")
        .WithTags("social");

        // --- Like (HMAC + idempotency) ---
        group.MapPut("/social/posts/{postId}/likes/{accountId}", async (
            string postId,
            string accountId,
            SocialReactionSetRequestDto request,
            HttpContext http,
            ISocialGraphService graph,
            WorldMapMetrics metrics,
            CancellationToken ct) =>
        {
            var auth = EndpointHelpers.Auth(http);
            if (EndpointHelpers.RequireIdempotencyKey(http, auth.IdempotencyKey) is { } bad)
            {
                return bad;
            }

            var result = await graph.SetLikeAsync(auth.CivId, postId, accountId, request, auth.IdempotencyKey, ct);
            return Mutation(result, http, metrics, "like");
        })
        .AddEndpointFilter<HmacAuthEndpointFilter>()
        .WithName("setSocialPostLike")
        .WithTags("social");
    }

    /// <summary>Renders a social mutation result: status/Location + RateLimit-* headers, else problem+json.</summary>
    private static IResult Mutation<T>(Result<SocialMutationEnvelope<T>> result, HttpContext http, WorldMapMetrics metrics, string operation)
    {
        if (!result.IsSuccess)
        {
            if (result.Error.Code == ErrorCode.RateLimited)
            {
                metrics.RecordSocialRateLimited(operation);
            }

            return ApiResults.Problem(result.Error, http);
        }

        var envelope = result.Value;
        if (envelope.RateHeaders is { } headers)
        {
            http.Response.Headers["RateLimit-Limit"] = headers.Limit.ToString();
            http.Response.Headers["RateLimit-Remaining"] = headers.Remaining.ToString();
            http.Response.Headers["RateLimit-Reset"] = headers.ResetEpochSeconds.ToString();
        }

        metrics.RecordSocialMutation(operation);

        return envelope.StatusCode == StatusCodes.Status201Created && envelope.Location is not null
            ? TypedResults.Created(envelope.Location, envelope.Body)
            : TypedResults.Ok(envelope.Body);
    }
}
