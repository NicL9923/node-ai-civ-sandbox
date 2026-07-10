using System.Net;
using System.Text.Json.Serialization;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;
using WorldMap.Core.Configuration;
using WorldMap.Core.Sequencing;

namespace WorldMap.Infrastructure.Cosmos;

/// <summary>
/// Cosmos-backed monotonic sequence allocator. Each sequence is a single counter document that is
/// advanced with an atomic <c>PatchOperation.Increment</c>; the patched resource carries the new
/// value. A missing counter is lazily seeded at 0 (create-wins under races), so the first allocated
/// value is 1. Global worldsequence uses one doc; each civ's command sequence uses its own.
/// </summary>
public sealed class CosmosSequenceAllocator(CosmosClient client, IOptions<WorldMapOptions> options)
    : ISequenceAllocator
{
    private const string WorldSequenceId = "worldsequence";

    private readonly Container _container =
        client.GetContainer(options.Value.Storage.DatabaseName, CosmosContainers.Sequences);

    public async ValueTask<long> NextWorldSequenceAsync(CancellationToken ct)
        => await IncrementAsync(WorldSequenceId, ct);

    public async ValueTask<long> NextCommandSequenceAsync(string civId, CancellationToken ct)
        => await IncrementAsync($"cmd:{civId}", ct);

    private async Task<long> IncrementAsync(string sequenceId, CancellationToken ct)
    {
        var id = CosmosId.Hash(sequenceId);
        var partitionKey = new PartitionKey(sequenceId);
        var patch = new[] { PatchOperation.Increment("/value", 1L) };

        try
        {
            var response = await _container.PatchItemAsync<SequenceDoc>(id, partitionKey, patch, cancellationToken: ct);
            return response.Resource.Value;
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            await SeedAsync(id, sequenceId, partitionKey, ct);
            var response = await _container.PatchItemAsync<SequenceDoc>(id, partitionKey, patch, cancellationToken: ct);
            return response.Resource.Value;
        }
    }

    private async Task SeedAsync(string id, string sequenceId, PartitionKey partitionKey, CancellationToken ct)
    {
        try
        {
            var seed = new SequenceDoc { Id = id, Pk = sequenceId, Value = 0 };
            await _container.CreateItemAsync(seed, partitionKey, cancellationToken: ct);
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.Conflict)
        {
            // Another instance seeded first; the subsequent increment still observes a valid counter.
        }
    }

    private sealed class SequenceDoc
    {
        [JsonPropertyName("id")]
        public string Id { get; set; } = default!;

        [JsonPropertyName("pk")]
        public string Pk { get; set; } = default!;

        [JsonPropertyName("value")]
        public long Value { get; set; }
    }
}
