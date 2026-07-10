using System.Collections.Concurrent;
using System.Net;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Configuration;
using WorldMap.Core.Domain;

namespace WorldMap.Infrastructure.Cosmos;

/// <summary>
/// Cosmos-backed per-civ command queue.
///
/// <para><b>Doc id / PK.</b> id = deterministic <c>CommandId</c> (so an idempotent enqueue is a
/// create-conflict); PK = <c>TargetCivId</c> so pulls and pending counts stay single-partition.
/// The <c>expiresAt</c> is promoted to the queryable top-level <c>expiresAtEpoch</c> (UTC seconds)
/// for the expiry sweep.</para>
///
/// <para><b>Atomic <c>CommandSequence</c>.</b> Assigned by a per-civ <see cref="CosmosSequenceAllocator"/>
/// (allocate-through-insert), so an offline civ's forward-only pull cursor never skips a
/// not-yet-committed command. Enqueue is idempotent by <c>CommandId</c>.</para>
///
/// <para><b>CAS ack.</b> <see cref="TryAckAsync"/>/<see cref="MarkExpiredAsync"/> read then
/// conditionally <c>Replace</c> with <c>IfMatchEtag</c>; a 412 re-reads and re-evaluates so a
/// terminal ack is never overwritten.</para>
/// </summary>
public sealed class CosmosCommandRepository : ICommandRepository
{
    private const int MaxCasAttempts = 5;

    private readonly Container _container;
    private readonly Container _counters;
    private readonly TimeProvider _clock;
    private readonly ConcurrentDictionary<string, CosmosSequenceAllocator> _sequences = new(StringComparer.Ordinal);

    public CosmosCommandRepository(CosmosClient client, IOptions<WorldMapOptions> options, TimeProvider clock)
    {
        ArgumentNullException.ThrowIfNull(client);
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(clock);
        _clock = clock;
        var database = options.Value.Storage.DatabaseName;
        _container = client.GetContainer(database, CosmosContainers.Commands);
        _counters = client.GetContainer(database, CosmosContainers.Sequences);
    }

    public async Task<Command?> GetAsync(string targetCivId, string commandId, CancellationToken ct)
    {
        try
        {
            var response = await _container.ReadItemAsync<CosmosDoc<Command>>(
                commandId, new PartitionKey(targetCivId), cancellationToken: ct).ConfigureAwait(false);
            return Hydrate(response.Resource);
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }
    }

    public async Task<Command> EnqueueAsync(Command command, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(command);

        // Idempotent by CommandId: an already-enqueued command returns unchanged (no new sequence).
        var existing = await GetAsync(command.TargetCivId, command.CommandId, ct).ConfigureAwait(false);
        if (existing is not null)
        {
            return existing;
        }

        var allocator = _sequences.GetOrAdd(
            command.TargetCivId,
            civ => new CosmosSequenceAllocator(_counters, $"command:{civ}"));

        return await allocator.AllocateAsync(
            token => MaxCommandSequenceAsync(command.TargetCivId, token),
            async (next, token) =>
            {
                command.CommandSequence = next;
                var doc = CosmosDoc.Create(
                    command.CommandId, command.TargetCivId, command,
                    expiresAtEpoch: ToEpoch(command.ExpiresAt));
                try
                {
                    var response = await _container.CreateItemAsync(
                        doc, new PartitionKey(command.TargetCivId), cancellationToken: token).ConfigureAwait(false);
                    return new SequenceInsert<Command>(true, Hydrate(response.Resource));
                }
                catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.Conflict)
                {
                    var duplicate = await GetAsync(command.TargetCivId, command.CommandId, token).ConfigureAwait(false);
                    return new SequenceInsert<Command>(false, duplicate ?? command);
                }
            },
            ct).ConfigureAwait(false);
    }

    public async Task<CommandAckTransition> TryAckAsync(
        string targetCivId, string commandId, CommandAckStatus status, DateTimeOffset now, CancellationToken ct)
    {
        for (var attempt = 0; attempt < MaxCasAttempts; attempt++)
        {
            var doc = await ReadDocAsync(targetCivId, commandId, ct).ConfigureAwait(false)
                ?? throw new InvalidOperationException($"Command '{commandId}' not found for '{targetCivId}'.");

            if (doc.Payload.AckStatus is not null)
            {
                return new CommandAckTransition(false, Hydrate(doc)); // Terminal — never overwrite.
            }

            doc.Payload.AckStatus = status;
            doc.Payload.AckedAt = now;
            doc.Payload.Version++;

            try
            {
                var response = await ReplaceAsync(doc, targetCivId, ct).ConfigureAwait(false);
                return new CommandAckTransition(true, Hydrate(response.Resource));
            }
            catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.PreconditionFailed)
            {
                // Lost the race: re-read; if it became acked meanwhile, report the winner's outcome.
            }
        }

        var latest = await GetAsync(targetCivId, commandId, ct).ConfigureAwait(false)
            ?? throw new InvalidOperationException($"Command '{commandId}' not found for '{targetCivId}'.");
        return new CommandAckTransition(false, latest);
    }

    public async Task MarkAckReconciledAsync(string targetCivId, string commandId, CancellationToken ct)
    {
        for (var attempt = 0; attempt < MaxCasAttempts; attempt++)
        {
            var doc = await ReadDocAsync(targetCivId, commandId, ct).ConfigureAwait(false);
            if (doc is null || doc.Payload.AckReconciled)
            {
                return;
            }

            doc.Payload.AckReconciled = true;
            try
            {
                await ReplaceAsync(doc, targetCivId, ct).ConfigureAwait(false);
                return;
            }
            catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.PreconditionFailed)
            {
                // Retry against the newest revision.
            }
        }
    }

    public async Task MarkExpiredAsync(string targetCivId, string commandId, CancellationToken ct)
    {
        for (var attempt = 0; attempt < MaxCasAttempts; attempt++)
        {
            var doc = await ReadDocAsync(targetCivId, commandId, ct).ConfigureAwait(false);
            if (doc is null || doc.Payload.AckStatus is not null || doc.Payload.Expired)
            {
                return; // No-op if already acked/expired (compare-and-set).
            }

            doc.Payload.Expired = true;
            doc.Payload.Version++;
            try
            {
                await ReplaceAsync(doc, targetCivId, ct).ConfigureAwait(false);
                return;
            }
            catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.PreconditionFailed)
            {
                // Retry against the newest revision.
            }
        }
    }

    public async Task<IReadOnlyList<Command>> PullAsync(
        string targetCivId, long afterSequence, int limit, CancellationToken ct)
    {
        // Only un-acked, un-expired (by flag AND actual expiry time) commands past the cursor, ascending.
        var nowEpoch = _clock.GetUtcNow().ToUnixTimeSeconds();
        var query = new QueryDefinition(
                "SELECT * FROM c WHERE IS_NULL(c.payload.ackStatus) AND c.payload.expired = false " +
                "AND (NOT IS_DEFINED(c.expiresAtEpoch) OR c.expiresAtEpoch = null OR c.expiresAtEpoch > @now) " +
                "AND c.payload.commandSequence > @after ORDER BY c.payload.commandSequence ASC OFFSET 0 LIMIT @limit")
            .WithParameter("@after", afterSequence)
            .WithParameter("@now", nowEpoch)
            .WithParameter("@limit", limit);
        var requestOptions = new QueryRequestOptions { PartitionKey = new PartitionKey(targetCivId) };

        var results = new List<Command>();
        using var iterator = _container.GetItemQueryIterator<CosmosDoc<Command>>(query, requestOptions: requestOptions);
        while (iterator.HasMoreResults)
        {
            foreach (var doc in await iterator.ReadNextAsync(ct).ConfigureAwait(false))
            {
                results.Add(Hydrate(doc));
            }
        }

        return results;
    }

    public async Task<int> CountPendingAsync(string targetCivId, CancellationToken ct)
    {
        var nowEpoch = _clock.GetUtcNow().ToUnixTimeSeconds();
        var query = new QueryDefinition(
                "SELECT VALUE COUNT(1) FROM c WHERE IS_NULL(c.payload.ackStatus) AND c.payload.expired = false " +
                "AND (NOT IS_DEFINED(c.expiresAtEpoch) OR c.expiresAtEpoch = null OR c.expiresAtEpoch > @now)")
            .WithParameter("@now", nowEpoch);
        var requestOptions = new QueryRequestOptions { PartitionKey = new PartitionKey(targetCivId) };

        using var iterator = _container.GetItemQueryIterator<int>(query, requestOptions: requestOptions);
        var count = 0;
        while (iterator.HasMoreResults)
        {
            foreach (var value in await iterator.ReadNextAsync(ct).ConfigureAwait(false))
            {
                count += value;
            }
        }

        return count;
    }

    public async Task<IReadOnlyList<Command>> ListExpirableAsync(DateTimeOffset now, CancellationToken ct)
    {
        // Numeric epoch comparison (offset-safe) on the promoted top-level field.
        var query = new QueryDefinition(
                "SELECT * FROM c WHERE IS_NULL(c.payload.ackStatus) AND c.payload.expired = false " +
                "AND IS_DEFINED(c.expiresAtEpoch) AND c.expiresAtEpoch != null AND c.expiresAtEpoch <= @now")
            .WithParameter("@now", now.ToUnixTimeSeconds());

        return await RunCrossPartitionAsync(query, ct).ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<Command>> ListUnreconciledAsync(CancellationToken ct)
    {
        var query = new QueryDefinition(
            "SELECT * FROM c WHERE NOT IS_NULL(c.payload.ackStatus) AND c.payload.ackReconciled = false");
        return await RunCrossPartitionAsync(query, ct).ConfigureAwait(false);
    }

    private async Task<List<Command>> RunCrossPartitionAsync(QueryDefinition query, CancellationToken ct)
    {
        var results = new List<Command>();
        using var iterator = _container.GetItemQueryIterator<CosmosDoc<Command>>(query);
        while (iterator.HasMoreResults)
        {
            foreach (var doc in await iterator.ReadNextAsync(ct).ConfigureAwait(false))
            {
                results.Add(Hydrate(doc));
            }
        }

        return results;
    }

    private async Task<CosmosDoc<Command>?> ReadDocAsync(string targetCivId, string commandId, CancellationToken ct)
    {
        try
        {
            var response = await _container.ReadItemAsync<CosmosDoc<Command>>(
                commandId, new PartitionKey(targetCivId), cancellationToken: ct).ConfigureAwait(false);
            return response.Resource;
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }
    }

    private Task<ItemResponse<CosmosDoc<Command>>> ReplaceAsync(
        CosmosDoc<Command> doc, string targetCivId, CancellationToken ct)
    {
        doc.ExpiresAtEpoch = ToEpoch(doc.Payload.ExpiresAt);
        var options = new ItemRequestOptions { IfMatchEtag = doc.Etag };
        return _container.ReplaceItemAsync(doc, doc.Id, new PartitionKey(targetCivId), options, ct);
    }

    private async Task<long> MaxCommandSequenceAsync(string targetCivId, CancellationToken ct)
    {
        var query = new QueryDefinition("SELECT VALUE MAX(c.payload.commandSequence) FROM c");
        var requestOptions = new QueryRequestOptions { PartitionKey = new PartitionKey(targetCivId) };
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

    private static long? ToEpoch(DateTimeOffset? value) => value?.ToUnixTimeSeconds();

    private static Command Hydrate(CosmosDoc<Command> doc)
    {
        var command = doc.Payload;
        command.Etag = doc.Etag;
        return command;
    }
}
