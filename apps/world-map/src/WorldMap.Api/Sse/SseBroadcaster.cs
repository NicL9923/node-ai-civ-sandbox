using System.Collections.Concurrent;
using System.Threading.Channels;
using WorldMap.Core.Abstractions;
using WorldMap.Core.Contracts;

namespace WorldMap.Api.Sse;

/// <summary>
/// A single shared, bounded broadcaster for the public world-event SSE stream. Public events are
/// pushed here at commit time (via <see cref="IWorldEventSink"/>) and fanned out to subscribers'
/// bounded channels — replacing per-client polling. Each subscriber has a capped buffer with a
/// drop-oldest policy, so a slow consumer degrades (drops frames, catches up via <c>/events</c>)
/// without back-pressuring ingestion. A global subscriber cap bounds resource use.
/// </summary>
public sealed class SseBroadcaster(ILogger<SseBroadcaster> logger) : IWorldEventSink
{
    private const int PerSubscriberCapacity = 256;
    private const int MaxSubscribers = 1000;

    private readonly ConcurrentDictionary<Guid, Channel<CloudEventDto>> _subscribers = new();

    public int SubscriberCount => _subscribers.Count;

    public void Publish(CloudEventDto publicEvent)
    {
        foreach (var channel in _subscribers.Values)
        {
            // Bounded + DropOldest: a slow consumer loses the oldest buffered frame, never blocks.
            channel.Writer.TryWrite(publicEvent);
        }
    }

    /// <summary>Registers a subscriber. Returns null if the global subscriber cap is reached.</summary>
    public SseSubscription? Subscribe()
    {
        if (_subscribers.Count >= MaxSubscribers)
        {
            logger.LogWarning("SSE subscriber cap ({Cap}) reached; rejecting a new subscription.", MaxSubscribers);
            return null;
        }

        var id = Guid.NewGuid();
        var channel = Channel.CreateBounded<CloudEventDto>(new BoundedChannelOptions(PerSubscriberCapacity)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
            SingleWriter = false,
        });

        _subscribers[id] = channel;
        return new SseSubscription(channel.Reader, () =>
        {
            if (_subscribers.TryRemove(id, out var removed))
            {
                removed.Writer.TryComplete();
            }
        });
    }
}

/// <summary>A live SSE subscription: a bounded reader plus a cleanup handle disposed on disconnect.</summary>
public sealed class SseSubscription(ChannelReader<CloudEventDto> reader, Action onDispose) : IDisposable
{
    public ChannelReader<CloudEventDto> Reader { get; } = reader;

    public void Dispose() => onDispose();
}
