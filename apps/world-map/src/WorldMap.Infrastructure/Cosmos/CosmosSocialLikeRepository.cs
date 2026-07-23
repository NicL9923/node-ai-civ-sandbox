using System.Net;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Configuration;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.Cosmos;

/// <summary>
/// Cosmos-backed canonical like edges (doc id = <see cref="SocialIds.LikeDocId"/>; PK = <c>PostId</c>
/// so a post's likes are single-partition). <see cref="TryUpsertAsync"/> is a compare-and-set via
/// <c>IfMatchEtag</c>: it returns <c>false</c> on a 412 (stored version moved on) or a lost
/// first-insert race so the caller reloads and retries.
/// </summary>
public sealed class CosmosSocialLikeRepository : ISocialLikeRepository
{
    private readonly Container _container;

    public CosmosSocialLikeRepository(CosmosClient client, IOptions<WorldMapOptions> options)
    {
        ArgumentNullException.ThrowIfNull(client);
        ArgumentNullException.ThrowIfNull(options);
        _container = client.GetContainer(options.Value.Storage.DatabaseName, CosmosContainers.SocialLikes);
    }

    public async Task<SocialLike?> GetAsync(string postId, string accountId, CancellationToken ct)
    {
        var id = SocialIds.LikeDocId(postId, accountId);
        try
        {
            var response = await _container.ReadItemAsync<CosmosDoc<SocialLike>>(
                id, new PartitionKey(postId), cancellationToken: ct).ConfigureAwait(false);
            return Hydrate(response.Resource);
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }
    }

    public async Task<bool> TryUpsertAsync(SocialLike like, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(like);
        var id = SocialIds.LikeDocId(like.PostId, like.AccountId);
        var pk = like.PostId;
        // The caller owns the Version increment (matching the InMemory CAS contract); Cosmos concurrency
        // is enforced by IfMatchEtag. Do not double-increment here or the backends would diverge.
        var doc = CosmosDoc.Create(id, pk, like);
        try
        {
            if (like.Etag is null)
            {
                var created = await _container.CreateItemAsync(
                    doc, new PartitionKey(pk), cancellationToken: ct).ConfigureAwait(false);
                like.Etag = created.ETag;
                return true;
            }

            var options = new ItemRequestOptions { IfMatchEtag = like.Etag };
            var response = await _container.ReplaceItemAsync(
                doc, id, new PartitionKey(pk), options, ct).ConfigureAwait(false);
            like.Etag = response.ETag;
            return true;
        }
        catch (CosmosException ex) when (ex.StatusCode is HttpStatusCode.PreconditionFailed or HttpStatusCode.Conflict)
        {
            return false; // Concurrent writer won — caller reloads and retries.
        }
    }

    public async Task<IReadOnlyList<SocialLike>> ListPendingAsync(CancellationToken ct)
    {
        // Cross-partition: an un-evented committed transition on any post's like edge.
        var query = new QueryDefinition("SELECT * FROM c WHERE c.payload.pending = true");
        var items = new List<SocialLike>();
        using var iterator = _container.GetItemQueryIterator<CosmosDoc<SocialLike>>(query);
        while (iterator.HasMoreResults)
        {
            foreach (var doc in await iterator.ReadNextAsync(ct).ConfigureAwait(false))
            {
                items.Add(Hydrate(doc));
            }
        }

        return items;
    }

    public async Task<long> CountActiveLikesAsync(string postId, CancellationToken ct)
    {
        var query = new QueryDefinition("SELECT VALUE COUNT(1) FROM c WHERE c.payload.liked = true");
        var requestOptions = new QueryRequestOptions { PartitionKey = new PartitionKey(postId) };
        using var iterator = _container.GetItemQueryIterator<long>(query, requestOptions: requestOptions);
        long total = 0;
        while (iterator.HasMoreResults)
        {
            foreach (var value in await iterator.ReadNextAsync(ct).ConfigureAwait(false))
            {
                total += value;
            }
        }

        return total;
    }

    private static SocialLike Hydrate(CosmosDoc<SocialLike> doc)
    {
        var like = doc.Payload;
        like.Etag = doc.Etag;
        return like;
    }
}
