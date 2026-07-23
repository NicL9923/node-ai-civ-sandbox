using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using WorldMap.Core.Contracts;
using WorldMap.IntegrationTests.Harness;

namespace WorldMap.IntegrationTests.Tests;

/// <summary>
/// World Wire social runtime end-to-end: account sync identity/authority, posts/replies/threads,
/// tombstones, desired-state follow/like, feeds + cursor binding, authorization, Unicode bounds,
/// idempotency, and citizen-safe event privacy — exercised over the real signed HTTP stack.
/// </summary>
public sealed class SocialTests : WorldTestBase
{
    private static string Key() => Guid.NewGuid().ToString("N");

    private static async Task<SocialAccountSyncResponseDto> OkSyncAsync(HttpResponseMessage r)
    {
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        return (await r.Content.ReadFromJsonAsync<SocialAccountSyncResponseDto>(WorldMapJson.Options))!;
    }

    private static async Task<SocialPostDto> OkPostAsync(HttpResponseMessage r, HttpStatusCode expected)
    {
        Assert.Equal(expected, r.StatusCode);
        return (await r.Content.ReadFromJsonAsync<SocialPostDto>(WorldMapJson.Options))!;
    }

    // --- Account sync ---

    [Fact]
    public async Task Sync_creates_accounts_in_request_order_with_stable_ids()
    {
        var civ = await Factory.RegisterCivAsync(Client, "Aurora");
        var req = SocialDtos.Sync(civ.CivId,
            SocialDtos.Agent(civ.CivId, "agent_ada", "Ada", "Builder."),
            SocialDtos.Official(civ.CivId, "Aurora", "agent_ada", 3, "term_3"));

        var body = await OkSyncAsync(await SocialApi.SyncAsync(Client, civ, req, Key()));

        Assert.Equal(2, body.Accounts.Count);
        Assert.Equal("agent", body.Accounts[0].Actor.Kind);
        Assert.Equal("official", body.Accounts[1].Actor.Kind);
        Assert.Equal("Ada", body.Accounts[0].Actor.DisplayName);

        // Re-sync with a changed display name: identity (accountId) is stable across the change.
        var renamed = SocialDtos.Sync(civ.CivId, SocialDtos.Agent(civ.CivId, "agent_ada", "Ada the Builder"));
        var body2 = await OkSyncAsync(await SocialApi.SyncAsync(Client, civ, renamed, Key()));
        Assert.Equal(body.Accounts[0].AccountId, body2.Accounts[0].AccountId);
        Assert.Equal("Ada the Builder", body2.Accounts[0].Actor.DisplayName);
    }

    [Fact]
    public async Task Sync_replay_returns_identical_response_and_conflicts_on_different_body()
    {
        var civ = await Factory.RegisterCivAsync(Client, "Aurora");
        var key = Key();
        var req = SocialDtos.Sync(civ.CivId, SocialDtos.Agent(civ.CivId, "agent_ada", "Ada"));

        var first = await OkSyncAsync(await SocialApi.SyncAsync(Client, civ, req, key));
        var replay = await OkSyncAsync(await SocialApi.SyncAsync(Client, civ, req, key));
        Assert.Equal(first.Accounts[0].AccountId, replay.Accounts[0].AccountId);
        Assert.Equal(first.Accounts[0].Worldsequence, replay.Accounts[0].Worldsequence);

        // Same key, different body -> hard idempotency conflict.
        var other = SocialDtos.Sync(civ.CivId, SocialDtos.Agent(civ.CivId, "agent_bob", "Bob"));
        var conflict = await SocialApi.SyncAsync(Client, civ, other, key);
        Assert.Equal(HttpStatusCode.Conflict, conflict.StatusCode);
        Assert.Equal("idempotency_conflict", (await ProblemBody.ReadAsync(conflict)).Code);
    }

    [Fact]
    public async Task Sync_rejects_system_kind_duplicate_keys_and_multiple_officials()
    {
        var civ = await Factory.RegisterCivAsync(Client, "Aurora");

        var system = SocialDtos.Sync(civ.CivId, new SocialAccountUpsertDto
        {
            Actor = new SocialActorRefDto { CivId = civ.CivId, DisplayName = "Sys", Kind = "system" },
        });
        Assert.Equal("system_account_reserved", (await ProblemBody.ReadAsync(await SocialApi.SyncAsync(Client, civ, system, Key()))).Code);

        var dup = SocialDtos.Sync(civ.CivId,
            SocialDtos.Agent(civ.CivId, "agent_ada", "Ada"),
            SocialDtos.Agent(civ.CivId, "agent_ada", "Ada2"));
        Assert.Equal(HttpStatusCode.BadRequest, (await SocialApi.SyncAsync(Client, civ, dup, Key())).StatusCode);

        var twoOfficials = SocialDtos.Sync(civ.CivId,
            SocialDtos.Official(civ.CivId, "Aurora", "agent_ada", 1, "term_1"),
            SocialDtos.Official(civ.CivId, "Aurora2", "agent_bob", 1, "term_1"));
        Assert.Equal("official_account_conflict", (await ProblemBody.ReadAsync(await SocialApi.SyncAsync(Client, civ, twoOfficials, Key()))).Code);
    }

    [Fact]
    public async Task Sync_rejects_civ_mismatch_and_missing_agent_local_id()
    {
        var civ = await Factory.RegisterCivAsync(Client, "Aurora");

        var mixed = SocialDtos.Sync(civ.CivId, SocialDtos.Agent("civ_other", "agent_x", "X"));
        Assert.Equal(HttpStatusCode.BadRequest, (await SocialApi.SyncAsync(Client, civ, mixed, Key())).StatusCode);

        var noLocal = SocialDtos.Sync(civ.CivId, new SocialAccountUpsertDto
        {
            Actor = new SocialActorRefDto { CivId = civ.CivId, DisplayName = "Nameless", Kind = "agent" },
        });
        Assert.Equal(HttpStatusCode.BadRequest, (await SocialApi.SyncAsync(Client, civ, noLocal, Key())).StatusCode);
    }

    // --- Posts, replies, threads ---

    [Fact]
    public async Task Post_create_appears_in_global_feed_and_is_readable()
    {
        var civ = await Factory.RegisterCivAsync(Client, "Aurora");
        var acct = await SocialApi.SyncAgentAsync(Client, civ, "agent_ada", "Ada");

        var created = await OkPostAsync(
            await SocialApi.CreatePostAsync(Client, civ, SocialDtos.Post(acct, "Hello, World Wire.", "agent_ada"), Key()),
            HttpStatusCode.Created);
        Assert.Equal("published", created.Status);
        Assert.Equal(0, created.ReplyDepth);
        Assert.Null(created.ParentPostId);
        Assert.Equal(created.PostId, created.ConversationRootPostId);

        var fetched = await OkPostAsync(await Client.GetAsync($"/world/v1/social/posts/{created.PostId}"), HttpStatusCode.OK);
        Assert.Equal("Hello, World Wire.", fetched.Text);

        var feed = (await Client.GetFromJsonAsync<SocialPostPageDto>("/world/v1/social/feed", WorldMapJson.Options))!;
        Assert.Contains(feed.Items, p => p.PostId == created.PostId);
    }

    [Fact]
    public async Task Reply_derives_root_depth_and_thread_is_oldest_first()
    {
        var civ = await Factory.RegisterCivAsync(Client, "Aurora");
        var acct = await SocialApi.SyncAgentAsync(Client, civ, "agent_ada", "Ada");

        var root = await OkPostAsync(await SocialApi.CreatePostAsync(Client, civ, SocialDtos.Post(acct, "root", "agent_ada"), Key()), HttpStatusCode.Created);
        var reply = await OkPostAsync(await SocialApi.CreatePostAsync(Client, civ, SocialDtos.Post(acct, "reply", "agent_ada", root.PostId), Key()), HttpStatusCode.Created);

        Assert.Equal(1, reply.ReplyDepth);
        Assert.Equal(root.PostId, reply.ParentPostId);
        Assert.Equal(root.PostId, reply.ConversationRootPostId);

        var thread = (await Client.GetFromJsonAsync<SocialThreadPageDto>($"/world/v1/social/posts/{reply.PostId}/thread", WorldMapJson.Options))!;
        Assert.Equal(root.PostId, thread.ConversationRootPostId);
        Assert.Equal(2, thread.Items.Count);
        Assert.Equal(root.PostId, thread.Items[0].PostId); // oldest first
        Assert.Equal(reply.PostId, thread.Items[1].PostId);
    }

    [Fact]
    public async Task Reply_depth_capped_at_four()
    {
        var civ = await Factory.RegisterCivAsync(Client, "Aurora");
        var acct = await SocialApi.SyncAgentAsync(Client, civ, "agent_ada", "Ada");

        string? parent = null;
        for (var depth = 0; depth <= 4; depth++)
        {
            var post = await OkPostAsync(await SocialApi.CreatePostAsync(Client, civ, SocialDtos.Post(acct, $"d{depth}", "agent_ada", parent), Key()), HttpStatusCode.Created);
            Assert.Equal(depth, post.ReplyDepth);
            parent = post.PostId;
        }

        // A 5th-level reply (depth 5) is rejected.
        var tooDeep = await SocialApi.CreatePostAsync(Client, civ, SocialDtos.Post(acct, "d5", "agent_ada", parent), Key());
        Assert.Equal(HttpStatusCode.Conflict, tooDeep.StatusCode);
        Assert.Equal("reply_depth_exceeded", (await ProblemBody.ReadAsync(tooDeep)).Code);
    }

    [Fact]
    public async Task Post_content_bounds_use_unicode_code_points()
    {
        var civ = await Factory.RegisterCivAsync(Client, "Aurora");
        var acct = await SocialApi.SyncAgentAsync(Client, civ, "agent_ada", "Ada");

        // 280 emoji = 280 code points (560 UTF-16 units) — accepted; 281 — content_too_long.
        var ok = string.Concat(Enumerable.Repeat("\U0001F642", 280));
        Assert.Equal(HttpStatusCode.Created, (await SocialApi.CreatePostAsync(Client, civ, SocialDtos.Post(acct, ok, "agent_ada"), Key())).StatusCode);

        var tooLong = string.Concat(Enumerable.Repeat("\U0001F642", 281));
        var longResp = await SocialApi.CreatePostAsync(Client, civ, SocialDtos.Post(acct, tooLong, "agent_ada"), Key());
        Assert.Equal("content_too_long", (await ProblemBody.ReadAsync(longResp)).Code);

        var blank = await SocialApi.CreatePostAsync(Client, civ, SocialDtos.Post(acct, "   ", "agent_ada"), Key());
        Assert.Equal("invalid_social_content", (await ProblemBody.ReadAsync(blank)).Code);
    }

    [Fact]
    public async Task Tombstone_is_terminal_idempotent_and_clears_text()
    {
        var civ = await Factory.RegisterCivAsync(Client, "Aurora");
        var acct = await SocialApi.SyncAgentAsync(Client, civ, "agent_ada", "Ada");
        var post = await OkPostAsync(await SocialApi.CreatePostAsync(Client, civ, SocialDtos.Post(acct, "regrettable", "agent_ada"), Key()), HttpStatusCode.Created);

        var tomb = await OkPostAsync(await SocialApi.TombstoneAsync(Client, civ, post.PostId, SocialDtos.Tombstone("agent_ada"), Key()), HttpStatusCode.OK);
        Assert.Equal("tombstoned", tomb.Status);
        Assert.Null(tomb.Text);
        Assert.NotNull(tomb.TombstonedAt);

        // A new reply to a tombstoned parent is rejected; existing identity is preserved.
        var reply = await SocialApi.CreatePostAsync(Client, civ, SocialDtos.Post(acct, "late", "agent_ada", post.PostId), Key());
        Assert.Equal("post_tombstoned", (await ProblemBody.ReadAsync(reply)).Code);

        // Idempotent: a second tombstone (new key) still returns the terminal projection.
        var again = await OkPostAsync(await SocialApi.TombstoneAsync(Client, civ, post.PostId, SocialDtos.Tombstone("agent_ada"), Key()), HttpStatusCode.OK);
        Assert.Equal("tombstoned", again.Status);
    }

    // --- Authorization ---

    [Fact]
    public async Task Post_authorization_is_world_owned()
    {
        var aurora = await Factory.RegisterCivAsync(Client, "Aurora");
        var borealis = await Factory.RegisterCivAsync(Client, "Borealis");
        var auroraAcct = await SocialApi.SyncAgentAsync(Client, aurora, "agent_ada", "Ada");

        // Unknown author account.
        Assert.Equal("social_account_not_found",
            (await ProblemBody.ReadAsync(await SocialApi.CreatePostAsync(Client, aurora, SocialDtos.Post("acct_missing", "hi", "agent_ada"), Key()))).Code);

        // Another civ cannot post as Aurora's account (HMAC civ != account owner).
        Assert.Equal("forbidden_account",
            (await ProblemBody.ReadAsync(await SocialApi.CreatePostAsync(Client, borealis, SocialDtos.Post(auroraAcct, "hi", "agent_ada"), Key()))).Code);

        // Wrong acting local agent for the account.
        Assert.Equal("forbidden_actor",
            (await ProblemBody.ReadAsync(await SocialApi.CreatePostAsync(Client, aurora, SocialDtos.Post(auroraAcct, "hi", "agent_wrong"), Key()))).Code);
    }

    // --- Follows and likes ---

    [Fact]
    public async Task Follow_is_desired_state_with_changed_semantics_and_self_follow_forbidden()
    {
        var civ = await Factory.RegisterCivAsync(Client, "Aurora");
        var a = await SocialApi.SyncAgentAsync(Client, civ, "agent_a", "A");
        var b = await SocialApi.SyncAgentAsync(Client, civ, "agent_b", "B");

        var follow = await SocialApi.FollowAsync(Client, civ, a, b, SocialDtos.Follow(true, "agent_a"), Key());
        var f1 = (await follow.Content.ReadFromJsonAsync<SocialFollowDto>(WorldMapJson.Options))!;
        Assert.True(f1.Following);
        Assert.True(f1.Changed);

        // Re-applying the same desired state succeeds with changed:false (never inverts).
        var f2 = (await (await SocialApi.FollowAsync(Client, civ, a, b, SocialDtos.Follow(true, "agent_a"), Key())).Content.ReadFromJsonAsync<SocialFollowDto>(WorldMapJson.Options))!;
        Assert.True(f2.Following);
        Assert.False(f2.Changed);

        // Self-follow forbidden.
        Assert.Equal("self_follow_forbidden",
            (await ProblemBody.ReadAsync(await SocialApi.FollowAsync(Client, civ, a, a, SocialDtos.Follow(true, "agent_a"), Key()))).Code);

        // Unfollow of an absent edge succeeds as a no-op.
        var c = await SocialApi.SyncAgentAsync(Client, civ, "agent_c", "C");
        var noop = (await (await SocialApi.FollowAsync(Client, civ, a, c, SocialDtos.Follow(false, "agent_a"), Key())).Content.ReadFromJsonAsync<SocialFollowDto>(WorldMapJson.Options))!;
        Assert.False(noop.Following);
        Assert.False(noop.Changed);
    }

    [Fact]
    public async Task Like_is_desired_state_and_self_like_allowed()
    {
        var civ = await Factory.RegisterCivAsync(Client, "Aurora");
        var acct = await SocialApi.SyncAgentAsync(Client, civ, "agent_ada", "Ada");
        var post = await OkPostAsync(await SocialApi.CreatePostAsync(Client, civ, SocialDtos.Post(acct, "like me", "agent_ada"), Key()), HttpStatusCode.Created);

        var like = (await (await SocialApi.LikeAsync(Client, civ, post.PostId, acct, SocialDtos.Like(true, "agent_ada"), Key())).Content.ReadFromJsonAsync<SocialReactionDto>(WorldMapJson.Options))!;
        Assert.True(like.Liked);
        Assert.True(like.Changed);
        Assert.Equal(1, like.LikeCount);

        var again = (await (await SocialApi.LikeAsync(Client, civ, post.PostId, acct, SocialDtos.Like(true, "agent_ada"), Key())).Content.ReadFromJsonAsync<SocialReactionDto>(WorldMapJson.Options))!;
        Assert.False(again.Changed);
        Assert.Equal(1, again.LikeCount);
    }

    // --- Feeds and cursor ---

    [Fact]
    public async Task Following_feed_snapshot_excludes_posts_created_after_the_first_page()
    {
        var civ = await Factory.RegisterCivAsync(Client, "Aurora");
        var reader = await SocialApi.SyncAgentAsync(Client, civ, "agent_reader", "Reader");
        var author = await SocialApi.SyncAgentAsync(Client, civ, "agent_author", "Author");

        await SocialApi.FollowAsync(Client, civ, reader, author, SocialDtos.Follow(true, "agent_reader"), Key());
        var p1 = await OkPostAsync(await SocialApi.CreatePostAsync(Client, civ, SocialDtos.Post(author, "first", "agent_author"), Key()), HttpStatusCode.Created);

        // First page freezes the snapshot high-watermark at p1.
        var page1 = (await Client.GetFromJsonAsync<SocialPostPageDto>($"/world/v1/social/accounts/{reader}/feed?limit=1", WorldMapJson.Options))!;
        Assert.Single(page1.Items);
        Assert.Equal(p1.PostId, page1.Items[0].PostId);
        Assert.NotNull(page1.NextCursor);

        // A new post after the snapshot must not appear when the traversal continues.
        var p2 = await OkPostAsync(await SocialApi.CreatePostAsync(Client, civ, SocialDtos.Post(author, "second", "agent_author"), Key()), HttpStatusCode.Created);
        var page2 = (await Client.GetFromJsonAsync<SocialPostPageDto>($"/world/v1/social/accounts/{reader}/feed?limit=1&cursor={page1.NextCursor}", WorldMapJson.Options))!;
        Assert.DoesNotContain(page2.Items, p => p.PostId == p2.PostId);
    }

    [Fact]
    public async Task Cursor_bound_to_endpoint_rejects_reuse_on_another_feed()
    {
        var civ = await Factory.RegisterCivAsync(Client, "Aurora");
        var acct = await SocialApi.SyncAgentAsync(Client, civ, "agent_ada", "Ada");
        await OkPostAsync(await SocialApi.CreatePostAsync(Client, civ, SocialDtos.Post(acct, "a", "agent_ada"), Key()), HttpStatusCode.Created);
        await OkPostAsync(await SocialApi.CreatePostAsync(Client, civ, SocialDtos.Post(acct, "b", "agent_ada"), Key()), HttpStatusCode.Created);

        var global = (await Client.GetFromJsonAsync<SocialPostPageDto>("/world/v1/social/feed?limit=1", WorldMapJson.Options))!;
        Assert.NotNull(global.NextCursor);

        // Reusing the global-feed cursor on the account-posts feed is a cursor_filter_mismatch.
        var misuse = await Client.GetAsync($"/world/v1/social/accounts/{acct}/posts?cursor={global.NextCursor}");
        Assert.Equal(HttpStatusCode.BadRequest, misuse.StatusCode);
        Assert.Equal("cursor_filter_mismatch", (await ProblemBody.ReadAsync(misuse)).Code);

        // A structurally malformed cursor is likewise a mismatch.
        var malformed = await Client.GetAsync("/world/v1/social/feed?cursor=!!!not-base64!!!");
        Assert.Equal("cursor_filter_mismatch", (await ProblemBody.ReadAsync(malformed)).Code);
    }

    // --- Events (citizen-safe) ---

    [Fact]
    public async Task Post_created_event_is_public_and_excludes_authorization()
    {
        var civ = await Factory.RegisterCivAsync(Client, "Aurora");
        var acct = await SocialApi.SyncAgentAsync(Client, civ, "agent_ada", "Ada");
        var post = await OkPostAsync(await SocialApi.CreatePostAsync(Client, civ, SocialDtos.Post(acct, "public words", "agent_ada"), Key()), HttpStatusCode.Created);

        var events = (await Client.GetFromJsonAsync<EventPageDto>("/world/v1/events", WorldMapJson.Options))!;
        var created = events.Items.FirstOrDefault(e => e.Type == "world.social.post.created.v1");
        Assert.NotNull(created);

        var raw = JsonSerializer.Serialize(created, WorldMapJson.Options);
        Assert.Contains(post.PostId, raw);
        Assert.DoesNotContain("authorization", raw, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("actingLocalAgentId", raw, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("authorityDecision", raw, StringComparison.OrdinalIgnoreCase);

        // The account sync event is a bounded summary, never the submitted records.
        var synced = events.Items.FirstOrDefault(e => e.Type == "world.social.account.synced.v1");
        Assert.NotNull(synced);
        Assert.DoesNotContain("presidentLocalAgentId", JsonSerializer.Serialize(synced, WorldMapJson.Options), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Public_reads_require_no_signature()
    {
        var civ = await Factory.RegisterCivAsync(Client, "Aurora");
        var acct = await SocialApi.SyncAgentAsync(Client, civ, "agent_ada", "Ada");

        // An unsigned GET succeeds; an unknown account is a social_account_not_found.
        var ok = await Client.GetAsync($"/world/v1/social/accounts/{acct}");
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);

        var missing = await Client.GetAsync("/world/v1/social/accounts/acct_nope");
        Assert.Equal("social_account_not_found", (await ProblemBody.ReadAsync(missing)).Code);
    }

    [Fact]
    public async Task Post_replay_returns_same_post_id()
    {
        var civ = await Factory.RegisterCivAsync(Client, "Aurora");
        var acct = await SocialApi.SyncAgentAsync(Client, civ, "agent_ada", "Ada");
        var key = Key();
        var request = SocialDtos.Post(acct, "once", "agent_ada");

        var first = await OkPostAsync(await SocialApi.CreatePostAsync(Client, civ, request, key), HttpStatusCode.Created);
        var replay = await OkPostAsync(await SocialApi.CreatePostAsync(Client, civ, request, key), HttpStatusCode.Created);
        Assert.Equal(first.PostId, replay.PostId);
        Assert.Equal(first.Worldsequence, replay.Worldsequence);
    }
}
