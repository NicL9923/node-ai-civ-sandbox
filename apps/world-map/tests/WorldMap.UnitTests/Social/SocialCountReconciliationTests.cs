using WorldMap.Core.Abstractions;
using WorldMap.Core.Application;
using WorldMap.Core.Application.Impl;
using WorldMap.Core.Contracts;
using WorldMap.Core.Domain;
using WorldMap.UnitTests.Fakes;
using WorldMap.UnitTests.Services;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace WorldMap.UnitTests.Social;

/// <summary>
/// Count projections converge to their exact canonical values after crash windows and are idempotent under
/// repeated reconciliation. Covers a crash after an edge's evented CAS but before its count write, a crash
/// between two account count writes, and a crash after a like CAS before its count write — each repaired by
/// the absolute-count reconciliation sweep with no permanent under/over-count.
/// </summary>
public sealed class SocialCountReconciliationTests
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
        return result.Value.Body.Accounts[0].AccountId;
    }

    private static SocialGraphService Graph(TestWorld w, ISocialAccountRepository? accounts = null, ISocialPostRepository? posts = null) =>
        new(accounts ?? w.SocialAccountRepo, posts ?? w.SocialPostRepo, w.SocialFollowRepo, w.SocialLikeRepo,
            w.WorldEvents, w.SocialPipeline, new SocialEventFactory(w.Options), w.Sink, w.Clock);

    private static async Task<long> FollowerCount(TestWorld w, string accountId) =>
        (await w.SocialAccountService.GetAsync(accountId, CT)).Value.FollowerCount;

    private static async Task<long> FollowingCount(TestWorld w, string accountId) =>
        (await w.SocialAccountService.GetAsync(accountId, CT)).Value.FollowingCount;

    private static async Task<string> PostAsync(TestWorld w, string acct, string text, string localId)
    {
        var r = await w.SocialPostService.CreateAsync(Civ, new SocialPostCreateRequestDto { AuthorAccountId = acct, Text = text, Authorization = Auth(localId) }, Guid.NewGuid().ToString("N"), CT);
        return r.Value.Body.PostId;
    }

    [Fact]
    public async Task Reconciler_fixes_drift_and_is_idempotent()
    {
        var w = new TestWorld();
        var a = await SyncAgentAsync(w, "agent_a", "A");
        var b = await SyncAgentAsync(w, "agent_b", "B");
        await w.SocialGraphService.SetFollowAsync(Civ, a, b, new SocialFollowSetRequestDto { Following = true, Authorization = Auth("agent_a") }, Guid.NewGuid().ToString("N"), CT);

        // Corrupt the projection to simulate arbitrary drift.
        var account = await w.SocialAccountRepo.GetAsync(b, CT);
        account!.FollowerCount = 99;
        account.Version++;
        await w.SocialAccountRepo.TryUpdateAsync(account, CT);

        await w.SocialReconciler.ReconcileAsync(CT);
        Assert.Equal(1, await FollowerCount(w, b));

        // Idempotent: a second reconciliation leaves the exact value.
        await w.SocialReconciler.ReconcileAsync(CT);
        Assert.Equal(1, await FollowerCount(w, b));
        Assert.Equal(1, await FollowingCount(w, a));
    }

    [Fact]
    public async Task Crash_after_follow_evented_before_count_converges_on_reconcile()
    {
        var w = new TestWorld();
        var a = await SyncAgentAsync(w, "agent_a", "A");
        var b = await SyncAgentAsync(w, "agent_b", "B");

        // Fail the FIRST account count write: the edge commits + events, but no count is written.
        var graph = Graph(w, accounts: new FailOnAccountUpdate(w.SocialAccountRepo, throwOnCall: 1));
        await Assert.ThrowsAnyAsync<Exception>(() =>
            graph.SetFollowAsync(Civ, a, b, new SocialFollowSetRequestDto { Following = true, Authorization = Auth("agent_a") }, Guid.NewGuid().ToString("N"), CT));

        var edge = await w.SocialFollowRepo.GetAsync(a, b, CT);
        Assert.True(edge!.Following);
        Assert.False(edge.Pending); // evented
        Assert.Equal(0, await FollowerCount(w, b)); // count not yet written

        await w.SocialReconciler.ReconcileAsync(CT);
        Assert.Equal(1, await FollowerCount(w, b));
        Assert.Equal(1, await FollowingCount(w, a));

        await w.SocialReconciler.ReconcileAsync(CT); // idempotent
        Assert.Equal(1, await FollowerCount(w, b));
    }

    [Fact]
    public async Task Crash_between_two_follow_count_writes_converges_on_reconcile()
    {
        var w = new TestWorld();
        var a = await SyncAgentAsync(w, "agent_a", "A");
        var b = await SyncAgentAsync(w, "agent_b", "B");

        // Fail the SECOND account count write: one side is written, the other is not.
        var graph = Graph(w, accounts: new FailOnAccountUpdate(w.SocialAccountRepo, throwOnCall: 2));
        await Assert.ThrowsAnyAsync<Exception>(() =>
            graph.SetFollowAsync(Civ, a, b, new SocialFollowSetRequestDto { Following = true, Authorization = Auth("agent_a") }, Guid.NewGuid().ToString("N"), CT));

        await w.SocialReconciler.ReconcileAsync(CT);
        Assert.Equal(1, await FollowingCount(w, a));
        Assert.Equal(1, await FollowerCount(w, b));
    }

    [Fact]
    public async Task Crash_after_like_cas_before_count_converges_on_reconcile()
    {
        var w = new TestWorld();
        var acct = await SyncAgentAsync(w, "agent_ada", "Ada");
        var postId = await PostAsync(w, acct, "like me", "agent_ada");

        // Fail the like-count post write: the like edge commits + events, but LikeCount is not written.
        var graph = Graph(w, posts: new FailOnPostUpdate(w.SocialPostRepo, throwOnCall: 1));
        await Assert.ThrowsAnyAsync<Exception>(() =>
            graph.SetLikeAsync(Civ, postId, acct, new SocialReactionSetRequestDto { Liked = true, Authorization = Auth("agent_ada") }, Guid.NewGuid().ToString("N"), CT));

        var beforeReconcile = await w.SocialPostService.GetAsync(postId, CT);
        Assert.Equal(0, beforeReconcile.Value.LikeCount);

        await w.SocialReconciler.ReconcileAsync(CT);
        var afterReconcile = await w.SocialPostService.GetAsync(postId, CT);
        Assert.Equal(1, afterReconcile.Value.LikeCount);

        await w.SocialReconciler.ReconcileAsync(CT); // idempotent
        Assert.Equal(1, (await w.SocialPostService.GetAsync(postId, CT)).Value.LikeCount);
    }

    [Fact]
    public async Task Post_and_reply_counts_are_absolute_and_do_not_overcount_on_repeated_reconcile()
    {
        var w = new TestWorld();
        var acct = await SyncAgentAsync(w, "agent_ada", "Ada");
        var root = await PostAsync(w, acct, "root", "agent_ada");
        await PostAsync(w, acct, "reply", "agent_ada"); // separate root post (author now has 3 posts incl. next)
        await w.SocialPostService.CreateAsync(Civ, new SocialPostCreateRequestDto { AuthorAccountId = acct, Text = "child", ParentPostId = root, Authorization = Auth("agent_ada") }, Guid.NewGuid().ToString("N"), CT);

        // author has 3 posts (root, reply, child); root has 1 reply.
        await w.SocialReconciler.ReconcileAsync(CT);
        await w.SocialReconciler.ReconcileAsync(CT); // repeated — must not drift

        Assert.Equal(3, (await w.SocialAccountService.GetAsync(acct, CT)).Value.PostCount);
        Assert.Equal(1, (await w.SocialPostService.GetAsync(root, CT)).Value.ReplyCount);
    }

    private static SocialPostService PostServiceWith(TestWorld w, ISocialPostRepository posts) =>
        new(w.SocialAccountRepo, posts, w.SocialFeedRepo, w.WorldEvents, w.SocialPipeline,
            new SocialEventFactory(w.Options), w.Sink, w.Clock, w.Options, NullLogger<SocialPostService>.Instance);

    [Fact]
    public async Task Crash_after_post_author_count_before_step_cas_repairs_without_overcount()
    {
        var w = new TestWorld();
        var acct = await SyncAgentAsync(w, "agent_ada", "Ada");

        // Crash at the step CAS that finalizes the count step: the author PostCount has already been written.
        var crashing = PostServiceWith(w, new FailOnPostStep(w.SocialPostRepo, SocialPostStep.CountsUpdated));
        await Assert.ThrowsAnyAsync<Exception>(() => crashing.CreateAsync(
            Civ, new SocialPostCreateRequestDto { AuthorAccountId = acct, Text = "hello", Authorization = Auth("agent_ada") }, Guid.NewGuid().ToString("N"), CT));

        Assert.Equal(1, (await w.SocialAccountService.GetAsync(acct, CT)).Value.PostCount); // absolute write already applied

        // Repair sweep re-runs the state machine from Indexed; absolute counts do not double-apply.
        w.Clock.Advance(TimeSpan.FromSeconds(61));
        await w.Maintenance.SweepAsync(CT);
        await w.Maintenance.SweepAsync(CT); // idempotent
        Assert.Equal(1, (await w.SocialAccountService.GetAsync(acct, CT)).Value.PostCount);
    }

    [Fact]
    public async Task Crash_after_reply_parent_count_before_step_cas_repairs_without_overcount()
    {
        var w = new TestWorld();
        var acct = await SyncAgentAsync(w, "agent_ada", "Ada");
        var root = await PostAsync(w, acct, "root", "agent_ada");

        // Reply create crashes at the count-step CAS: the parent ReplyCount has already been written absolutely.
        var crashing = PostServiceWith(w, new FailOnPostStep(w.SocialPostRepo, SocialPostStep.CountsUpdated));
        await Assert.ThrowsAnyAsync<Exception>(() => crashing.CreateAsync(
            Civ, new SocialPostCreateRequestDto { AuthorAccountId = acct, Text = "child", ParentPostId = root, Authorization = Auth("agent_ada") }, Guid.NewGuid().ToString("N"), CT));

        Assert.Equal(1, (await w.SocialPostService.GetAsync(root, CT)).Value.ReplyCount);

        w.Clock.Advance(TimeSpan.FromSeconds(61));
        await w.Maintenance.SweepAsync(CT);
        await w.Maintenance.SweepAsync(CT); // idempotent
        Assert.Equal(1, (await w.SocialPostService.GetAsync(root, CT)).Value.ReplyCount);
        Assert.Equal(2, (await w.SocialAccountService.GetAsync(acct, CT)).Value.PostCount); // root + reply
    }
}
