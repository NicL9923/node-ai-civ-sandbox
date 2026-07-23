using System.Net;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Configuration;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.Cosmos;

/// <summary>
/// Cosmos-backed immutable world-sequence feed index (doc id = SHA-256 of <c>(scope, postId)</c>;
/// PK = <c>FeedScope</c> — the global scope or an author accountId). <see cref="AddEntryAsync"/> is
/// idempotent by (scope, postId): a create-conflict means the row is already indexed and is swallowed.
/// Reads are bounded by a snapshot high-watermark so new posts never appear mid-traversal.
/// </summary>
public sealed class CosmosSocialFeedRepository : ISocialFeedRepository
{
    private readonly Container _container;

    public CosmosSocialFeedRepository(CosmosClient client, IOptions<WorldMapOptions> options)
    {
        ArgumentNullException.ThrowIfNull(client);
        ArgumentNullException.ThrowIfNull(options);
        _container = client.GetContainer(options.Value.Storage.DatabaseName, CosmosContainers.SocialFeed);
    }

    public async Task AddEntryAsync(SocialFeedEntry entry, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(entry);
        var id = DocId(entry.FeedScope, entry.PostId);
        var doc = CosmosDoc.Create(id, entry.FeedScope, entry);
        try
        {
            await _container.CreateItemAsync(doc, new PartitionKey(entry.FeedScope), cancellationToken: ct).ConfigureAwait(false);
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.Conflict)
        {
            // Already indexed (idempotent create) — nothing to do.
        }
    }

    public async Task<long> MaxWorldsequenceAsync(string feedScope, CancellationToken ct)
    {
        var query = new QueryDefinition("SELECT VALUE MAX(c.payload.worldsequence) FROM c");
        var requestOptions = new QueryRequestOptions { PartitionKey = new PartitionKey(feedScope) };
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

    public async Task<IReadOnlyList<SocialFeedEntry>> ListDescendingAsync(
        string feedScope, long highWatermark, long afterWorldsequence, string afterPostId, int limit, CancellationToken ct)
    {
        var query = ScopePageQuery(highWatermark, afterWorldsequence, afterPostId, limit);
        var requestOptions = new QueryRequestOptions { PartitionKey = new PartitionKey(feedScope) };
        return await RunAsync(query, requestOptions, ct).ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<SocialFeedEntry>> ListFollowingDescendingAsync(
        IReadOnlyCollection<string> authorScopes, long highWatermark, long afterWorldsequence, string afterPostId, int limit, CancellationToken ct)
    {
        if (authorScopes is null || authorScopes.Count == 0)
        {
            return [];
        }

        // Fan out one bounded page per frozen author scope, then merge newest-first and truncate.
        var merged = new List<SocialFeedEntry>();
        foreach (var scope in authorScopes)
        {
            var query = ScopePageQuery(highWatermark, afterWorldsequence, afterPostId, limit);
            var requestOptions = new QueryRequestOptions { PartitionKey = new PartitionKey(scope) };
            merged.AddRange(await RunAsync(query, requestOptions, ct).ConfigureAwait(false));
        }

        merged.Sort(static (a, b) =>
        {
            var byWs = b.Worldsequence.CompareTo(a.Worldsequence); // worldsequence DESC
            return byWs != 0 ? byWs : string.CompareOrdinal(a.PostId, b.PostId); // postId ASC
        });

        return limit > 0 && merged.Count > limit ? merged.GetRange(0, limit) : merged;
    }

    private static QueryDefinition ScopePageQuery(long highWatermark, long afterWorldsequence, string afterPostId, int limit) =>
        new QueryDefinition(
                "SELECT * FROM c WHERE c.payload.worldsequence <= @hw " +
                "AND (c.payload.worldsequence < @afterWs OR (c.payload.worldsequence = @afterWs AND c.payload.postId > @afterTie)) " +
                "ORDER BY c.payload.worldsequence DESC, c.payload.postId ASC OFFSET 0 LIMIT @limit")
            .WithParameter("@hw", highWatermark)
            .WithParameter("@afterWs", afterWorldsequence)
            .WithParameter("@afterTie", afterPostId)
            .WithParameter("@limit", limit);

    private async Task<List<SocialFeedEntry>> RunAsync(
        QueryDefinition query, QueryRequestOptions requestOptions, CancellationToken ct)
    {
        var items = new List<SocialFeedEntry>();
        using var iterator = _container.GetItemQueryIterator<CosmosDoc<SocialFeedEntry>>(query, requestOptions: requestOptions);
        while (iterator.HasMoreResults)
        {
            foreach (var doc in await iterator.ReadNextAsync(ct).ConfigureAwait(false))
            {
                items.Add(doc.Payload);
            }
        }

        return items;
    }

    private static string DocId(string feedScope, string postId) => CosmosId.Hash($"{feedScope}\0{postId}");
}
