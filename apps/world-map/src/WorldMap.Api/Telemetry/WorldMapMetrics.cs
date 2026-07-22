using System.Diagnostics.Metrics;

namespace WorldMap.Api.Telemetry;

/// <summary>
/// Custom OpenTelemetry instruments for the World runtime. Registered as a singleton and
/// recorded at the API boundary (endpoints, HMAC filter, worker). Never records secrets
/// or payload contents — only counts, statuses, and sizes.
/// </summary>
public sealed class WorldMapMetrics : IDisposable
{
    public const string MeterName = "WorldMap";

    private readonly Meter _meter;

    private readonly Counter<long> _registrations;
    private readonly Counter<long> _authFailures;
    private readonly Counter<long> _interactionsSubmitted;
    private readonly Counter<long> _interactionAcks;
    private readonly Counter<long> _eventsIngested;
    private readonly Counter<long> _socialMutations;
    private readonly Counter<long> _socialRateLimited;
    private readonly Histogram<double> _interactionLatencyMs;

    public WorldMapMetrics(IMeterFactory meterFactory)
    {
        _meter = meterFactory.Create(MeterName);
        _registrations = _meter.CreateCounter<long>("worldmap.registrations", "registrations", "Civilizations registered.");
        _authFailures = _meter.CreateCounter<long>("worldmap.auth.failures", "failures", "HMAC auth/replay failures.");
        _interactionsSubmitted = _meter.CreateCounter<long>("worldmap.interactions.submitted", "interactions", "Interactions submitted.");
        _interactionAcks = _meter.CreateCounter<long>("worldmap.interactions.acks", "acks", "Command acks by status.");
        _eventsIngested = _meter.CreateCounter<long>("worldmap.events.ingested", "events", "Events ingested by outcome.");
        _socialMutations = _meter.CreateCounter<long>("worldmap.social.mutations", "mutations", "World Wire social mutations by operation.");
        _socialRateLimited = _meter.CreateCounter<long>("worldmap.social.ratelimited", "rejections", "World Wire social mutations rejected by the per-account rate limiter.");
        _interactionLatencyMs = _meter.CreateHistogram<double>("worldmap.interactions.submit.duration", "ms", "Interaction submit latency.");
    }

    public void RecordRegistration() => _registrations.Add(1);

    public void RecordAuthFailure(string reason) =>
        _authFailures.Add(1, new KeyValuePair<string, object?>("reason", reason));

    public void RecordInteractionSubmitted(string kind, bool duplicate) =>
        _interactionsSubmitted.Add(1,
            new KeyValuePair<string, object?>("kind", kind),
            new KeyValuePair<string, object?>("duplicate", duplicate));

    public void RecordInteractionLatency(double milliseconds) => _interactionLatencyMs.Record(milliseconds);

    public void RecordCommandAck(string status) =>
        _interactionAcks.Add(1, new KeyValuePair<string, object?>("status", status));

    public void RecordEventOutcome(string outcome, int count)
    {
        if (count > 0)
        {
            _eventsIngested.Add(count, new KeyValuePair<string, object?>("outcome", outcome));
        }
    }

    public void RecordSocialMutation(string operation) =>
        _socialMutations.Add(1, new KeyValuePair<string, object?>("operation", operation));

    public void RecordSocialRateLimited(string operation) =>
        _socialRateLimited.Add(1, new KeyValuePair<string, object?>("operation", operation));

    public void Dispose() => _meter.Dispose();
}
