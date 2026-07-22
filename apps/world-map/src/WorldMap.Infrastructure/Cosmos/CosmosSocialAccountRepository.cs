using System.Net;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Configuration;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.Cosmos;

/// <summary>
/// Cosmos-backed canonical account store (doc id = PK = <c>AccountId</c>). Identity is the
/// deterministic account id, so <see cref="UpsertAsync"/> is idempotent by id (a plain
/// create-or-replace canonical write). <see cref="TryUpdateAsync"/> is an optimistic-concurrency
/// write for the eventually-consistent count projections: it replaces with <c>IfMatchEtag</c> and
/// returns <c>false</c> on a 412 (or a lost first-insert race) so the caller reloads and retries.
/// </summary>
public sealed class CosmosSocialAccountRepository : ISocialAccountRepository
{
    private readonly Container _container;

    public CosmosSocialAccountRepository(CosmosClient client, IOptions<WorldMapOptions> options)
    {
        ArgumentNullException.ThrowIfNull(client);
        ArgumentNullException.ThrowIfNull(options);
        _container = client.GetContainer(options.Value.Storage.DatabaseName, CosmosContainers.SocialAccounts);
    }

    public async Task<SocialAccount?> GetAsync(string accountId, CancellationToken ct)
    {
        var doc = await ReadDocAsync(accountId, ct).ConfigureAwait(false);
        return doc is null ? null : Hydrate(doc);
    }

    public async Task UpsertAsync(SocialAccount account, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(account);
        var doc = CosmosDoc.Create(account.AccountId, account.AccountId, account);
        var response = await _container.UpsertItemAsync(
            doc, new PartitionKey(account.AccountId), cancellationToken: ct).ConfigureAwait(false);
        account.Etag = response.ETag;
    }

    public async Task<bool> TryUpdateAsync(SocialAccount account, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(account);
        // The caller owns the Version increment (matching the InMemory CAS contract); Cosmos concurrency
        // is enforced by IfMatchEtag. Do not double-increment here or the backends would diverge.
        var doc = CosmosDoc.Create(account.AccountId, account.AccountId, account);
        try
        {
            if (account.Etag is null)
            {
                var created = await _container.CreateItemAsync(
                    doc, new PartitionKey(account.AccountId), cancellationToken: ct).ConfigureAwait(false);
                account.Etag = created.ETag;
                return true;
            }

            var options = new ItemRequestOptions { IfMatchEtag = account.Etag };
            var response = await _container.ReplaceItemAsync(
                doc, account.AccountId, new PartitionKey(account.AccountId), options, ct).ConfigureAwait(false);
            account.Etag = response.ETag;
            return true;
        }
        catch (CosmosException ex) when (ex.StatusCode is HttpStatusCode.PreconditionFailed or HttpStatusCode.Conflict)
        {
            return false; // Concurrent writer won — caller reloads and retries.
        }
    }

    private async Task<CosmosDoc<SocialAccount>?> ReadDocAsync(string accountId, CancellationToken ct)
    {
        try
        {
            var response = await _container.ReadItemAsync<CosmosDoc<SocialAccount>>(
                accountId, new PartitionKey(accountId), cancellationToken: ct).ConfigureAwait(false);
            return response.Resource;
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }
    }

    private static SocialAccount Hydrate(CosmosDoc<SocialAccount> doc)
    {
        var account = doc.Payload;
        account.Etag = doc.Etag;
        return account;
    }
}
