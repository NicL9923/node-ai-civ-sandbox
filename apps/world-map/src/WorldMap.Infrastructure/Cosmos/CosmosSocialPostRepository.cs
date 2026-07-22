using System.Net;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Configuration;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.Cosmos;

/// <summary>
/// Cosmos-backed canonical post store (doc id = <c>PostId</c>; PK = <c>ConversationRootPostId</c> so a
/// thread is single-partition). <see cref="AddAsync"/> is idempotent by the deterministic post id (a
/// create-conflict returns the stored post). <see cref="TryUpdateAsync"/> is a compare-and-set via
/// <c>IfMatchEtag</c>. A by-id read is cross-partition (posts partition by root, not by id).
/// </summary>
public sealed class CosmosSocialPostRepository : ISocialPostRepository
{
    /// <summary>Bounds the cross-partition repair scan for posts stuck before <see cref="SocialPostStep.Done"/>.</summary>
    private const int IncompleteScanLimit = 1000;

    private readonly Container _container;
    private readonly CosmosSequenceAllocator _sequence;

    public CosmosSocialPostRepository(CosmosClient client, IOptions<WorldMapOptions> options)
    {
        ArgumentNullException.ThrowIfNull(client);
        ArgumentNullException.ThrowIfNull(options);
        var database = options.Value.Storage.DatabaseName;
        _container = client.GetContainer(database, CosmosContainers.SocialPosts);
        var counters = client.GetContainer(database, CosmosContainers.Sequences);
        _sequence = new CosmosSequenceAllocator(counters, "social:post:worldsequence");
    }

    public async Task<SocialPost?> GetAsync(string postId, CancellationToken ct)
    {
        // Posts partition by conversation root, so a point read by id alone is cross-partition.
        var query = new QueryDefinition("SELECT * FROM c WHERE c.id = @id").WithParameter("@id", postId);
        using var iterator = _container.GetItemQueryIterator<CosmosDoc<SocialPost>>(query);
        while (iterator.HasMoreResults)
        {
            foreach (var doc in await iterator.ReadNextAsync(ct).ConfigureAwait(false))
            {
                return Hydrate(doc);
            }
        }

        return null;
    }

    public async Task<SocialPost> AddAsync(SocialPost post, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(post);

        // Fast-path idempotent create: an already-stored post returns without consuming a sequence.
        var existing = await GetAsync(post.PostId, ct).ConfigureAwait(false);
        if (existing is not null)
        {
            return existing;
        }

        // Allocate-through-insert: the post's creation worldsequence is committed with the record so a
        // reader's forward-only feed cursor never advances past a not-yet-committed post.
        return await _sequence.AllocateAsync(
            MaxWorldsequenceAsync,
            async (next, token) =>
            {
                post.Worldsequence = next;
                var doc = CosmosDoc.Create(post.PostId, post.ConversationRootPostId, post);
                try
                {
                    var created = await _container.CreateItemAsync(
                        doc, new PartitionKey(post.ConversationRootPostId), cancellationToken: token).ConfigureAwait(false);
                    post.Etag = created.ETag;
                    return new SequenceInsert<SocialPost>(true, post);
                }
                catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.Conflict)
                {
                    // A concurrent writer stored it first: release the number, return the stored post.
                    var stored = await GetAsync(post.PostId, token).ConfigureAwait(false) ?? post;
                    return new SequenceInsert<SocialPost>(false, stored);
                }
            },
            ct).ConfigureAwait(false);
    }

    public async Task<bool> TryUpdateAsync(SocialPost post, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(post);
        // The caller owns the Version increment (matching the InMemory CAS contract); Cosmos concurrency
        // is enforced by IfMatchEtag. Do not double-increment here or the backends would diverge.
        var doc = CosmosDoc.Create(post.PostId, post.ConversationRootPostId, post);
        try
        {
            if (post.Etag is null)
            {
                var created = await _container.CreateItemAsync(
                    doc, new PartitionKey(post.ConversationRootPostId), cancellationToken: ct).ConfigureAwait(false);
                post.Etag = created.ETag;
                return true;
            }

            var options = new ItemRequestOptions { IfMatchEtag = post.Etag };
            var response = await _container.ReplaceItemAsync(
                doc, post.PostId, new PartitionKey(post.ConversationRootPostId), options, ct).ConfigureAwait(false);
            post.Etag = response.ETag;
            return true;
        }
        catch (CosmosException ex) when (ex.StatusCode is HttpStatusCode.PreconditionFailed or HttpStatusCode.Conflict)
        {
            return false; // Concurrent writer won — caller reloads and retries.
        }
    }

    public async Task<IReadOnlyList<SocialPost>> ListThreadAsync(
        string conversationRootPostId, long highWatermark, long afterWorldsequence, string afterPostId, int limit, CancellationToken ct)
    {
        var query = new QueryDefinition(
                "SELECT * FROM c WHERE c.payload.worldsequence <= @hw " +
                "AND (c.payload.worldsequence > @afterWs OR (c.payload.worldsequence = @afterWs AND c.payload.postId > @afterTie)) " +
                "ORDER BY c.payload.worldsequence ASC, c.payload.postId ASC OFFSET 0 LIMIT @limit")
            .WithParameter("@hw", highWatermark)
            .WithParameter("@afterWs", afterWorldsequence)
            .WithParameter("@afterTie", afterPostId)
            .WithParameter("@limit", limit);
        var requestOptions = new QueryRequestOptions { PartitionKey = new PartitionKey(conversationRootPostId) };

        return await RunAsync(query, requestOptions, ct).ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<SocialPost>> ListIncompleteAsync(CancellationToken ct)
    {
        // Step serializes as its numeric enum value (STJ Web defaults); Done == 4.
        var query = new QueryDefinition(
                "SELECT * FROM c WHERE c.payload.step != @done OFFSET 0 LIMIT @limit")
            .WithParameter("@done", (int)SocialPostStep.Done)
            .WithParameter("@limit", IncompleteScanLimit);

        return await RunAsync(query, requestOptions: null, ct).ConfigureAwait(false);
    }

    public async Task<long> MaxThreadWorldsequenceAsync(string conversationRootPostId, CancellationToken ct)
    {
        var query = new QueryDefinition("SELECT VALUE MAX(c.payload.worldsequence) FROM c");
        var requestOptions = new QueryRequestOptions { PartitionKey = new PartitionKey(conversationRootPostId) };
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

    private async Task<List<SocialPost>> RunAsync(
        QueryDefinition query, QueryRequestOptions? requestOptions, CancellationToken ct)
    {
        var items = new List<SocialPost>();
        using var iterator = _container.GetItemQueryIterator<CosmosDoc<SocialPost>>(query, requestOptions: requestOptions);
        while (iterator.HasMoreResults)
        {
            foreach (var doc in await iterator.ReadNextAsync(ct).ConfigureAwait(false))
            {
                items.Add(Hydrate(doc));
            }
        }

        return items;
    }

    private async Task<CosmosDoc<SocialPost>?> ReadDocAsync(string postId, string conversationRootPostId, CancellationToken ct)
    {
        try
        {
            var response = await _container.ReadItemAsync<CosmosDoc<SocialPost>>(
                postId, new PartitionKey(conversationRootPostId), cancellationToken: ct).ConfigureAwait(false);
            return response.Resource;
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }
    }

    private async Task<long> MaxWorldsequenceAsync(CancellationToken ct)
    {
        var query = new QueryDefinition("SELECT VALUE MAX(c.payload.worldsequence) FROM c");
        using var iterator = _container.GetItemQueryIterator<long?>(query);
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

    private static SocialPost Hydrate(CosmosDoc<SocialPost> doc)
    {
        var post = doc.Payload;
        post.Etag = doc.Etag;
        return post;
    }
}
