using Microsoft.Extensions.Logging.Abstractions;
using WorldMap.Core.Application;
using WorldMap.Core.Application.Impl;
using WorldMap.Core.Contracts;
using WorldMap.Core.Domain;
using WorldMap.UnitTests.Fakes;
using WorldMap.UnitTests.Services;
using Xunit;

namespace WorldMap.UnitTests.Social;

/// <summary>
/// Concurrency, crash-repair, and global-sequence invariants for the World Wire social runtime:
/// exactly one public event per logical edge/post transition (in the durable ledger AND the live sink),
/// crash windows after a canonical CAS are repaired to exactly one event, and every post's worldsequence
/// equals its post.created/reply.created event's envelope worldsequence.
/// </summary>
public sealed class SocialConcurrencyAndRepairTests
{
    private const string Civ = "civ_ra";
    private static readonly CancellationToken CT = CancellationToken.None;

    private static SocialMutationAuthorizationDto Auth(string localId) => new()
    {
        ActingLocalAgentId = localId,
        AuthorityDecision = new AuthorityDecisionDto { Mode = "agent", Ref = "intent" },
    };

    private static async Task<string> SyncAgentAsync(TestWorld w, string localId, string name)
    {
        var request = new SocialAccountSyncRequestDto
        {
            CivId = Civ,
            Accounts = [new SocialAccountUpsertDto { Actor = new SocialActorRefDto { CivId = Civ, LocalAgentId = localId, DisplayName = name, Kind = "agent" } }],
        };
        var result = await w.SocialAccountService.SyncAsync(Civ, request, Guid.NewGuid().ToString("N"), CT);
        Assert.True(result.IsSuccess);
        return result.Value.Body.Accounts[0].AccountId;
    }

    private static SocialGraphService Graph(TestWorld w, Core.Abstractions.IWorldEventRepository? events = null, Core.Abstractions.ISocialFollowRepository? follows = null, Core.Abstractions.ISocialLikeRepository? likes = null) =>
        new(w.SocialAccountRepo, w.SocialPostRepo, follows ?? w.SocialFollowRepo, likes ?? w.SocialLikeRepo,
            events ?? w.WorldEvents, w.SocialPipeline, new SocialEventFactory(w.Options), w.Sink, w.Clock);

    private static SocialPostService Posts(TestWorld w, Core.Abstractions.IWorldEventRepository events) =>
        new(w.SocialAccountRepo, w.SocialPostRepo, w.SocialFeedRepo, events, w.SocialPipeline,
            new SocialEventFactory(w.Options), w.Sink, w.Clock, w.Options, NullLogger<SocialPostService>.Instance);

    private async Task<List<WorldEvent>> LedgerAsync(TestWorld w) =>
        (await w.WorldEvents.ListAsync(0, 10_000, CT)).Items.ToList();

    private static int CountType(IEnumerable<WorldEvent> events, string type) => events.Count(e => e.Type == type);

    // 1 — concurrent follow(true) with distinct keys: one changed, one no-op, exactly one event, counts=1.
    [Fact]
    public async Task Concurrent_follow_produces_exactly_one_event_and_one_change()
    {
        var w = new TestWorld();
        var a = await SyncAgentAsync(w, "agent_a", "A");
        var b = await SyncAgentAsync(w, "agent_b", "B");

        var gated = new GatedSocialFollowRepository(w.SocialFollowRepo, 2);
        var graph = Graph(w, follows: gated);
        var req = new SocialFollowSetRequestDto { Following = true, Authorization = Auth("agent_a") };

        var t1 = graph.SetFollowAsync(Civ, a, b, req, Guid.NewGuid().ToString("N"), CT);
        var t2 = graph.SetFollowAsync(Civ, a, b, req, Guid.NewGuid().ToString("N"), CT);
        await gated.AllArrived; // both effects have read the (absent) edge
        gated.Release();
        var results = await Task.WhenAll(t1, t2);

        Assert.All(results, r => Assert.True(r.IsSuccess));
        Assert.Equal(1, results.Count(r => r.Value.Body.Changed));
        Assert.Equal(1, results.Count(r => !r.Value.Body.Changed));

        var ledger = await LedgerAsync(w);
        Assert.Equal(1, CountType(ledger, SocialEventTypes.AccountFollowed));
        Assert.Equal(1, w.Sink.Captured.Count(e => e.Type == SocialEventTypes.AccountFollowed));

        var target = await w.SocialAccountService.GetAsync(b, CT);
        Assert.Equal(1, target.Value.FollowerCount);
    }

    // 2 — concurrent like(true) with distinct keys: one changed, one no-op, exactly one event, likeCount=1.
    [Fact]
    public async Task Concurrent_like_produces_exactly_one_event_and_one_change()
    {
        var w = new TestWorld();
        var acct = await SyncAgentAsync(w, "agent_ada", "Ada");
        var post = await w.SocialPostService.CreateAsync(Civ, new SocialPostCreateRequestDto { AuthorAccountId = acct, Text = "hi", Authorization = Auth("agent_ada") }, Guid.NewGuid().ToString("N"), CT);
        var postId = post.Value.Body.PostId;

        var gated = new GatedSocialLikeRepository(w.SocialLikeRepo, 2);
        var graph = Graph(w, likes: gated);
        var req = new SocialReactionSetRequestDto { Liked = true, Authorization = Auth("agent_ada") };

        var t1 = graph.SetLikeAsync(Civ, postId, acct, req, Guid.NewGuid().ToString("N"), CT);
        var t2 = graph.SetLikeAsync(Civ, postId, acct, req, Guid.NewGuid().ToString("N"), CT);
        await gated.AllArrived;
        gated.Release();
        var results = await Task.WhenAll(t1, t2);

        Assert.Equal(1, results.Count(r => r.Value.Body.Changed));
        Assert.Equal(1, results.Count(r => !r.Value.Body.Changed));

        var ledger = await LedgerAsync(w);
        Assert.Equal(1, CountType(ledger, SocialEventTypes.PostLiked));
        Assert.Equal(1, w.Sink.Captured.Count(e => e.Type == SocialEventTypes.PostLiked));

        var fetched = await w.SocialPostService.GetAsync(postId, CT);
        Assert.Equal(1, fetched.Value.LikeCount);
    }

    // 3 — on→off→on yields one distinct event per transition; a repeated state emits none.
    [Fact]
    public async Task Follow_toggle_cycle_emits_one_event_per_transition()
    {
        var w = new TestWorld();
        var a = await SyncAgentAsync(w, "agent_a", "A");
        var b = await SyncAgentAsync(w, "agent_b", "B");

        async Task Set(bool following) =>
            Assert.True((await w.SocialGraphService.SetFollowAsync(Civ, a, b, new SocialFollowSetRequestDto { Following = following, Authorization = Auth("agent_a") }, Guid.NewGuid().ToString("N"), CT)).IsSuccess);

        await Set(true);
        await Set(false);
        await Set(true);
        await Set(true); // no-op — emits nothing

        var ledger = await LedgerAsync(w);
        Assert.Equal(2, CountType(ledger, SocialEventTypes.AccountFollowed));
        Assert.Equal(1, CountType(ledger, SocialEventTypes.AccountUnfollowed));

        // Three transition events with three distinct envelope worldsequences.
        var transitionSeqs = ledger.Where(e => e.Type is SocialEventTypes.AccountFollowed or SocialEventTypes.AccountUnfollowed)
            .Select(e => e.Worldsequence).ToList();
        Assert.Equal(3, transitionSeqs.Count);
        Assert.Equal(3, transitionSeqs.Distinct().Count());
    }

    // 4 — crash after the follow CAS but before the event append is repaired to exactly one event.
    [Fact]
    public async Task Crash_after_follow_cas_before_append_is_repaired_to_one_event()
    {
        var w = new TestWorld();
        var a = await SyncAgentAsync(w, "agent_a", "A");
        var b = await SyncAgentAsync(w, "agent_b", "B");

        var failing = Graph(w, events: new ThrowOnceBeforeWorldEventAppend(w.WorldEvents));
        await Assert.ThrowsAnyAsync<Exception>(() =>
            failing.SetFollowAsync(Civ, a, b, new SocialFollowSetRequestDto { Following = true, Authorization = Auth("agent_a") }, Guid.NewGuid().ToString("N"), CT));

        // State committed as pending; no event yet.
        var edge = await w.SocialFollowRepo.GetAsync(a, b, CT);
        Assert.NotNull(edge);
        Assert.True(edge!.Following);
        Assert.True(edge.Pending);
        Assert.Equal(0, CountType(await LedgerAsync(w), SocialEventTypes.AccountFollowed));

        // The repair sweep (after the pending lease) completes exactly one event.
        w.Clock.Advance(TimeSpan.FromSeconds(61));
        await w.SocialGraphService.RepairPendingAsync(CT);

        Assert.Equal(1, CountType(await LedgerAsync(w), SocialEventTypes.AccountFollowed));
        var repaired = await w.SocialFollowRepo.GetAsync(a, b, CT);
        Assert.False(repaired!.Pending);
        var target = await w.SocialAccountService.GetAsync(b, CT);
        Assert.Equal(1, target.Value.FollowerCount);
    }

    // 5 — crash after the post is persisted but before its event: the sweep appends one event, feeds it, Done.
    [Fact]
    public async Task Crash_after_post_persist_before_append_is_repaired_by_sweep()
    {
        var w = new TestWorld();
        var acct = await SyncAgentAsync(w, "agent_ada", "Ada");
        var key = Guid.NewGuid().ToString("N");
        var postId = SocialIds.PostId($"social:post:{Civ}:{key}");

        var failing = Posts(w, new ThrowOnceBeforeWorldEventAppend(w.WorldEvents));
        await Assert.ThrowsAnyAsync<Exception>(() =>
            failing.CreateAsync(Civ, new SocialPostCreateRequestDto { AuthorAccountId = acct, Text = "hi", Authorization = Auth("agent_ada") }, key, CT));

        Assert.Equal(0, CountType(await LedgerAsync(w), SocialEventTypes.PostCreated));
        Assert.Empty((await w.SocialFeedService.GlobalAsync(null, null, CT)).Value.Items);

        w.Clock.Advance(TimeSpan.FromSeconds(61));
        await w.SocialPostService.RepairIncompleteAsync(CT);

        var ledger = await LedgerAsync(w);
        Assert.Equal(1, CountType(ledger, SocialEventTypes.PostCreated));
        var post = await w.SocialPostRepo.GetAsync(postId, CT);
        Assert.NotNull(post);
        Assert.Equal(SocialPostStep.Done, post!.Step);
        var created = ledger.Single(e => e.Type == SocialEventTypes.PostCreated && e.Subject == postId);
        Assert.Equal(created.Worldsequence, post.Worldsequence); // post ws == event envelope ws
        Assert.Contains((await w.SocialFeedService.GlobalAsync(null, null, CT)).Value.Items, p => p.PostId == postId);
    }

    // 6 — crash after the event append (before finalize): retry/sweep reuses the SAME envelope worldsequence
    //     and never duplicates the ledger event.
    [Fact]
    public async Task Crash_after_post_event_append_reuses_same_sequence_without_duplicate()
    {
        var w = new TestWorld();
        var acct = await SyncAgentAsync(w, "agent_ada", "Ada");
        var key = Guid.NewGuid().ToString("N");
        var postId = SocialIds.PostId($"social:post:{Civ}:{key}");

        var failing = Posts(w, new ThrowOnceAfterWorldEventAppend(w.WorldEvents));
        await Assert.ThrowsAnyAsync<Exception>(() =>
            failing.CreateAsync(Civ, new SocialPostCreateRequestDto { AuthorAccountId = acct, Text = "hi", Authorization = Auth("agent_ada") }, key, CT));

        // The event is durably in the ledger even though the create effect threw before finalizing.
        var created = (await LedgerAsync(w)).Single(e => e.Type == SocialEventTypes.PostCreated && e.Subject == postId);
        var originalWs = created.Worldsequence;

        w.Clock.Advance(TimeSpan.FromSeconds(61));
        await w.SocialPostService.RepairIncompleteAsync(CT);

        var ledger = await LedgerAsync(w);
        Assert.Equal(1, CountType(ledger, SocialEventTypes.PostCreated)); // no duplicate
        var post = await w.SocialPostRepo.GetAsync(postId, CT);
        Assert.Equal(SocialPostStep.Done, post!.Step);
        Assert.Equal(originalWs, post.Worldsequence); // same reserved global envelope sequence
    }

    // 7 — every post's worldsequence equals its created/reply event envelope worldsequence, across
    //     interleaved non-social world events; the global feed follows this order.
    [Fact]
    public async Task Post_worldsequence_equals_created_event_envelope_across_interleaving()
    {
        var w = new TestWorld();
        var acct = await SyncAgentAsync(w, "agent_ada", "Ada");

        async Task InterleaveWorldEvent(string id) =>
            await w.WorldEvents.AppendAsync(new WorldEvent { EventId = id, Type = "world.other.v1", Source = "/x", Subject = id, DedupeKey = id, CreatedAt = w.Clock.GetUtcNow() }, CT);

        async Task<SocialPostDto> Post(string text, string key, string? parent = null) =>
            (await w.SocialPostService.CreateAsync(Civ, new SocialPostCreateRequestDto { AuthorAccountId = acct, Text = text, ParentPostId = parent, Authorization = Auth("agent_ada") }, key, CT)).Value.Body;

        await InterleaveWorldEvent("evt-1");
        var p1 = await Post("one", "k1");
        await InterleaveWorldEvent("evt-2");
        var p2 = await Post("two", "k2");
        var reply = await Post("re", "k3", p1.PostId);

        var ledger = await LedgerAsync(w);
        foreach (var post in new[] { p1, p2, reply })
        {
            var ev = ledger.Single(e => e.Subject == post.PostId
                && e.Type is SocialEventTypes.PostCreated or SocialEventTypes.ReplyCreated);
            Assert.Equal(ev.Worldsequence.ToString(), post.Worldsequence);
        }

        var feed = (await w.SocialFeedService.GlobalAsync(null, 50, CT)).Value.Items;
        var seqs = feed.Select(p => long.Parse(p.Worldsequence)).ToList();
        Assert.Equal(seqs.OrderByDescending(x => x).ToList(), seqs); // newest-first by the global order
    }

    // 8 — a tombstone leaves the post's creation worldsequence unchanged; the tombstone event is later.
    [Fact]
    public async Task Tombstone_preserves_creation_worldsequence_and_gets_a_later_event()
    {
        var w = new TestWorld();
        var acct = await SyncAgentAsync(w, "agent_ada", "Ada");
        var created = (await w.SocialPostService.CreateAsync(Civ, new SocialPostCreateRequestDto { AuthorAccountId = acct, Text = "bye", Authorization = Auth("agent_ada") }, Guid.NewGuid().ToString("N"), CT)).Value.Body;
        var creationWs = created.Worldsequence;

        var tomb = await w.SocialPostService.TombstoneAsync(Civ, created.PostId, new SocialPostTombstoneRequestDto { Authorization = Auth("agent_ada") }, Guid.NewGuid().ToString("N"), CT);
        Assert.True(tomb.IsSuccess);
        Assert.Equal(creationWs, tomb.Value.Body.Worldsequence); // creation sequence unchanged

        var ledger = await LedgerAsync(w);
        var tombEvent = ledger.Single(e => e.Type == SocialEventTypes.PostTombstoned && e.Subject == created.PostId);
        Assert.True(tombEvent.Worldsequence > long.Parse(creationWs)); // tombstone event has its own later envelope seq
    }
}
