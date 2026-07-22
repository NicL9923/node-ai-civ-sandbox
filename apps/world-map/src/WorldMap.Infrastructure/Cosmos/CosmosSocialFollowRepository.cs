using System.Net;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Configuration;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.Cosmos;

/// <summary>
/// Cosmos-backed canonical following edges (doc id = <see cref="SocialIds.FollowDocId"/>;
/// PK = <c>FollowerAccountId</c> so a follower's outbound edges are single-partition). Follower-side
/// reads (who follows a given account) are cross-partition. <see cref="TryUpsertAsync"/> is a
/// compare-and-set via <c>IfMatchEtag</c>: it returns <c>false</c> on a 412 (stored version moved on)
/// or a lost first-insert race so the caller reloads and retries.
/// </summary>
public sealed class CosmosSocialFollowRepository : ISocialFollowRepository
{
    private readonly Container _container;

    public CosmosSocialFollowRepository(CosmosClient client, IOptions<WorldMapOptions> options)
    {
        ArgumentNullException.ThrowIfNull(client);
        ArgumentNullException.ThrowIfNull(options);
        _container = client.GetContainer(options.Value.Storage.DatabaseName, CosmosContainers.SocialFollows);
    }

    public async Task<SocialFollow?> GetAsync(string followerAccountId, string followedAccountId, CancellationToken ct)
    {
        var id = SocialIds.FollowDocId(followerAccountId, followedAccountId);
        try
        {
            var response = await _container.ReadItemAsync<CosmosDoc<SocialFollow>>(
                id, new PartitionKey(followerAccountId), cancellationToken: ct).ConfigureAwait(false);
            return Hydrate(response.Resource);
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }
    }

    public async Task<bool> TryUpsertAsync(SocialFollow follow, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(follow);
        var id = SocialIds.FollowDocId(follow.FollowerAccountId, follow.FollowedAccountId);
        var pk = follow.FollowerAccountId;
        // The caller owns the Version increment (matching the InMemory CAS contract); Cosmos concurrency
        // is enforced by IfMatchEtag. Do not double-increment here or the backends would diverge.
        var doc = CosmosDoc.Create(id, pk, follow);
        try
        {
            if (follow.Etag is null)
            {
                var created = await _container.CreateItemAsync(
                    doc, new PartitionKey(pk), cancellationToken: ct).ConfigureAwait(false);
                follow.Etag = created.ETag;
                return true;
            }

            var options = new ItemRequestOptions { IfMatchEtag = follow.Etag };
            var response = await _container.ReplaceItemAsync(
                doc, id, new PartitionKey(pk), options, ct).ConfigureAwait(false);
            follow.Etag = response.ETag;
            return true;
        }
        catch (CosmosException ex) when (ex.StatusCode is HttpStatusCode.PreconditionFailed or HttpStatusCode.Conflict)
        {
            return false; // Concurrent writer won — caller reloads and retries.
        }
    }

    public async Task<IReadOnlyList<SocialFollow>> ListActiveFollowedAsync(string followerAccountId, CancellationToken ct)
    {
        var query = new QueryDefinition("SELECT * FROM c WHERE c.payload.following = true");
        var requestOptions = new QueryRequestOptions { PartitionKey = new PartitionKey(followerAccountId) };
        return await RunAsync(query, requestOptions, ct).ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<SocialFollow>> ListFollowedDescendingAsync(
        string followerAccountId, long highWatermark, long afterWorldsequence, string afterTieId, int limit, CancellationToken ct)
    {
        var query = new QueryDefinition(
                "SELECT * FROM c WHERE c.payload.following = true AND c.payload.worldsequence <= @hw " +
                "AND (c.payload.worldsequence < @afterWs OR (c.payload.worldsequence = @afterWs AND c.payload.followedAccountId > @afterTie)) " +
                "ORDER BY c.payload.worldsequence DESC, c.payload.followedAccountId ASC OFFSET 0 LIMIT @limit")
            .WithParameter("@hw", highWatermark)
            .WithParameter("@afterWs", afterWorldsequence)
            .WithParameter("@afterTie", afterTieId)
            .WithParameter("@limit", limit);
        var requestOptions = new QueryRequestOptions { PartitionKey = new PartitionKey(followerAccountId) };
        return await RunAsync(query, requestOptions, ct).ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<SocialFollow>> ListFollowersDescendingAsync(
        string followedAccountId, long highWatermark, long afterWorldsequence, string afterTieId, int limit, CancellationToken ct)
    {
        // Edges partition by follower, so listing an account's followers is cross-partition.
        var query = new QueryDefinition(
                "SELECT * FROM c WHERE c.payload.followedAccountId = @followed AND c.payload.following = true " +
                "AND c.payload.worldsequence <= @hw " +
                "AND (c.payload.worldsequence < @afterWs OR (c.payload.worldsequence = @afterWs AND c.payload.followerAccountId > @afterTie)) " +
                "ORDER BY c.payload.worldsequence DESC, c.payload.followerAccountId ASC OFFSET 0 LIMIT @limit")
            .WithParameter("@followed", followedAccountId)
            .WithParameter("@hw", highWatermark)
            .WithParameter("@afterWs", afterWorldsequence)
            .WithParameter("@afterTie", afterTieId)
            .WithParameter("@limit", limit);
        return await RunAsync(query, requestOptions: null, ct).ConfigureAwait(false);
    }

    public async Task<long> MaxFollowedWorldsequenceAsync(string followerAccountId, CancellationToken ct)
    {
        var query = new QueryDefinition(
            "SELECT VALUE MAX(c.payload.worldsequence) FROM c WHERE c.payload.following = true");
        var requestOptions = new QueryRequestOptions { PartitionKey = new PartitionKey(followerAccountId) };
        return await MaxAsync(query, requestOptions, ct).ConfigureAwait(false);
    }

    public async Task<long> MaxFollowersWorldsequenceAsync(string followedAccountId, CancellationToken ct)
    {
        var query = new QueryDefinition(
                "SELECT VALUE MAX(c.payload.worldsequence) FROM c WHERE c.payload.followedAccountId = @followed AND c.payload.following = true")
            .WithParameter("@followed", followedAccountId);
        return await MaxAsync(query, requestOptions: null, ct).ConfigureAwait(false);
    }

    private async Task<List<SocialFollow>> RunAsync(
        QueryDefinition query, QueryRequestOptions? requestOptions, CancellationToken ct)
    {
        var items = new List<SocialFollow>();
        using var iterator = _container.GetItemQueryIterator<CosmosDoc<SocialFollow>>(query, requestOptions: requestOptions);
        while (iterator.HasMoreResults)
        {
            foreach (var doc in await iterator.ReadNextAsync(ct).ConfigureAwait(false))
            {
                items.Add(Hydrate(doc));
            }
        }

        return items;
    }

    private async Task<long> MaxAsync(QueryDefinition query, QueryRequestOptions? requestOptions, CancellationToken ct)
    {
        using var iterator = _container.GetItemQueryIterator<long?>(query, requestOptions: requestOptions);
        long max = 0;
        while (iterator.HasMoreResults)
        {
            foreach (var value in await iterator.ReadNextAsync(ct).ConfigureAwait(false))
            {
                if (value is { } v && v > max)
                {
                    max = v;
                }
            }
        }

        return max;
    }

    private static SocialFollow Hydrate(CosmosDoc<SocialFollow> doc)
    {
        var follow = doc.Payload;
        follow.Etag = doc.Etag;
        return follow;
    }
}
