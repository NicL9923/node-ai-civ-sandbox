import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import {
  FakeCivilization,
  WorldFederationDriver,
  loadScenario,
  runScenario,
  type FakeCivilizationConfig,
  type ScenarioCivilization,
} from "@ai-civ/fake-civilization-testkit";
import {
  allocatePort,
  pollUntil,
  spawnManaged,
  stopManaged,
  waitForHttp,
  type ManagedProcess,
} from "./processes.js";
import {
  buildCivEnv,
  buildWorldEnv,
  CIV_FAKE,
  CIV_REAL,
  CONTACT_NARRATIVE,
  FAKE_DISPLAY_NAME,
  generateCredentials,
  KEY_FAKE,
  KEY_REAL,
  LIVENESS_OFFLINE_SECONDS,
  MESSAGE_NARRATIVE,
  privateSentinels,
  REAL_DISPLAY_NAME,
  secretValues,
  worldBaseUrl,
  type GeneratedCredentials,
} from "./world-config.js";
import { readSseUntil } from "./sse.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceDir = path.resolve(here, "..");
const repoRoot = path.resolve(workspaceDir, "..", "..");
const worldPublishDir =
  process.env.WORLD_E2E_PUBLISH_DIR ?? path.join(workspaceDir, ".artifacts", "publish");
const worldDll = path.join(worldPublishDir, "WorldMap.Api.dll");
const civEntry = path.join(repoRoot, "apps", "civilization", "dist", "server", "server", "index.js");
const scenarioPath = path.join(workspaceDir, "scenarios", "real-node-contact-message.scenario.json");

type AckBody = Parameters<WorldFederationDriver["ackCommand"]>[2];

let creds: GeneratedCredentials;
let worldPort: number;
let civPort: number;
let world: ManagedProcess | undefined;
let civ: ManagedProcess | undefined;
let fake: FakeCivilization;
let realObserver: WorldFederationDriver;
let allSecrets: string[];

const worldUrl = (p: string): string => `http://127.0.0.1:${worldPort}${p}`;
const civUrl = (p: string): string => `http://127.0.0.1:${civPort}${p}`;

async function getJson<T = any>(url: string): Promise<T> {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

async function adminPost(pathname: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(civUrl(pathname), {
    method: "POST",
    headers: {
      "x-admin-key": creds.adminKey,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

async function enqueueSocialAction(action: Record<string, unknown>): Promise<any> {
  const result = await adminPost("/api/admin/federation/social/actions", action);
  expect(result.status).toBe(202);
  expect(result.body).toEqual({ ok: true });
  return result.body;
}

function makeFakeConfig(): FakeCivilizationConfig {
  return {
    alias: "fake",
    displayName: FAKE_DISPLAY_NAME,
    worldBaseUrl: worldBaseUrl(worldPort),
    onboardingToken: creds.onboardingTokenFake,
    hmacSecret: creds.hmacSecretFake,
    capabilities: {
      protocolVersion: "1.0.0",
      supportedInteractionKinds: ["contact", "message"],
    },
  } as FakeCivilizationConfig;
}

test.beforeAll(async () => {
  if (!fs.existsSync(worldDll)) {
    throw new Error(
      `Missing published World at ${worldDll}. Run \`npm run test:federation-e2e\` from the repo root ` +
        `(it publishes WorldMap.Api and builds the civilization + testkit before invoking Playwright).`,
    );
  }
  if (!fs.existsSync(civEntry)) {
    throw new Error(
      `Missing compiled civilization at ${civEntry}. Run \`npm run build:civilization\` (the root ` +
        `\`test:federation-e2e\` script does this automatically).`,
    );
  }

  creds = generateCredentials();
  allSecrets = secretValues(creds);
  [worldPort, civPort] = await Promise.all([allocatePort(), allocatePort()]);

  // --- Start the single World writer (published DLL, InMemory, Development) ---
  world = spawnManaged({
    name: "world",
    command: "dotnet",
    args: [worldDll, "--urls", `http://127.0.0.1:${worldPort}`, "--contentRoot", worldPublishDir],
    env: buildWorldEnv(creds, worldPort, process.env),
    cwd: worldPublishDir,
    secrets: allSecrets,
  });
  await waitForHttp(
    worldUrl("/health/ready"),
    (status, body) => status === 200 && body.includes('"ready"'),
    { timeoutMs: 90_000, label: "World /health/ready" },
  );

  // --- Start the real compiled Node civilization (P3 connector, Memory store, mock AI) ---
  civ = spawnManaged({
    name: "civ",
    command: process.execPath,
    args: [civEntry],
    env: buildCivEnv(creds, civPort, worldPort, process.env),
    secrets: allSecrets,
  });
  await waitForHttp(
    civUrl("/healthz"),
    (status, body) => status === 200 && body.includes('"ok":true'),
    { timeoutMs: 60_000, label: "civilization /healthz" },
  );

  fake = new FakeCivilization(makeFakeConfig());
  realObserver = new WorldFederationDriver({
    baseUrl: worldBaseUrl(worldPort),
    credentials: () => ({ civId: CIV_REAL, keyId: KEY_REAL, secret: creds.hmacSecretReal }),
  });
});

test.afterAll(async () => {
  await stopManaged(civ);
  await stopManaged(world);
});

test("real-process federation: register, offline/resume, contact+message, exactly-once, observer & privacy", async ({
  page,
}) => {
  test.setTimeout(240_000);

  // Diagnostics collected from the browser across the whole run. Registered BEFORE any navigation.
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  const badPublicResponses: string[] = [];
  const capturedBodies: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    const url = request.url();
    const errorText = request.failure()?.errorText ?? "";
    // Long-lived SSE streams and any in-flight fetches are intentionally aborted by the browser on
    // reload/navigation; those client-cancellations are expected, not network faults.
    if (url.includes("favicon") || errorText.includes("ERR_ABORTED")) return;
    failedRequests.push(`${request.method()} ${url} ${errorText}`);
  });
  page.on("response", async (response) => {
    const url = response.url();
    if (!url.includes("/world/v1/") || url.includes("/stream")) return;
    if (response.request().method() === "GET" && response.status() >= 400) {
      badPublicResponses.push(`${response.status()} ${url}`);
    }
    try {
      capturedBodies.push(await response.text());
    } catch {
      // streaming/aborted body — ignore
    }
  });

  // === 1. Open the observer BEFORE any federation activity ===
  await test.step("observer loads before federation activity", async () => {
    await page.goto(worldUrl("/"));
    // The shell renders a header (banner) with the world summary and stream status.
    await expect(page.getByRole("banner")).toBeVisible({ timeout: 30_000 });
  });

  // === 2. Register both civilizations ===
  let fakeRegistration: any;
  await test.step("register real (admin) and fake (library) civilizations", async () => {
    const register = await adminPost("/api/admin/federation/register");
    expect(register.status).toBe(200);
    expect(register.body.registered).toBe(true);
    expect(register.body.civId).toBe(CIV_REAL);
    const heartbeat = await adminPost("/api/admin/federation/heartbeat");
    expect(heartbeat.status).toBe(200);

    fakeRegistration = await fake.register("fake-register-1");
    expect(fakeRegistration.civId).toBe(CIV_FAKE);
    expect(fakeRegistration.keyId).toBe(KEY_FAKE);
    // Registration metadata is present (protocol/registeredAt/worldBaseUrl); commandsCursor is null on
    // a first registration and legitimately omitted. No secret material is ever returned.
    expect(fakeRegistration.protocolVersion).toBe("1.0.0");
    expect(fakeRegistration.registeredAt).toBeTruthy();
    expect(fakeRegistration).not.toHaveProperty("secret");
    expect(JSON.stringify(fakeRegistration)).not.toContain(creds.hmacSecretFake);
    await fake.heartbeat();
  });

  // === 3. Both public projections appear; foreign affairs knows the fake civ (no credentials) ===
  const lastRealHeartbeatAt = Date.now();
  await test.step("public directory and foreign affairs reflect both civs", async () => {
    const civs = await pollUntil(
      async () => (await getJson<{ items: any[] }>(worldUrl("/world/v1/civilizations"))).items,
      (items) => items.some((c) => c.civId === CIV_REAL) && items.some((c) => c.civId === CIV_FAKE),
      { timeoutMs: 30_000, label: "both public projections" },
    );
    const names = civs.map((c) => c.displayName);
    expect(names).toContain(REAL_DISPLAY_NAME);
    expect(names).toContain(FAKE_DISPLAY_NAME);

    // The real civ's foreign-affairs view learns the fake civ via directory refresh (heartbeat/sync).
    const foreign = await pollUntil(
      async () => {
        await adminPost("/api/admin/federation/heartbeat");
        await adminPost("/api/admin/federation/sync");
        return await getJson<any>(civUrl("/api/world"));
      },
      (world) =>
        !!world.foreignAffairs?.registered &&
        (world.foreignAffairs.knownCivilizations ?? []).some((c: any) => c.civId === CIV_FAKE),
      { timeoutMs: 30_000, label: "foreignAffairs knows fake civ" },
    );
    const foreignJson = JSON.stringify(foreign.foreignAffairs);
    for (const secret of allSecrets) expect(foreignJson).not.toContain(secret);
  });

  // === 4. Withhold the real civ's heartbeat until it is offline by liveness ===
  await test.step("real civ transitions offline (liveness outage, process still alive)", async () => {
    await pollUntil(
      async () => await getJson<any>(worldUrl(`/world/v1/civilizations/${CIV_REAL}`)),
      (projection) => {
        const updated = Date.parse(projection.updatedAt);
        return Number.isFinite(updated) && Date.now() - updated >= LIVENESS_OFFLINE_SECONDS * 1000;
      },
      { timeoutMs: 30_000, intervalMs: 500, label: "real civ projection goes stale/offline" },
    );
    // The Node process is still serving — this is a protocol/liveness outage, not a store loss.
    const health = await fetch(civUrl("/healthz"));
    expect(health.status).toBe(200);
    expect(Date.now() - lastRealHeartbeatAt).toBeGreaterThanOrEqual(LIVENESS_OFFLINE_SECONDS * 1000);
  });

  // === 5. Fake civ produces an event (+replay +invalid source) and contact/message (+replays) ===
  let contactId: string;
  let messageId: string;
  await test.step("fake civ runs the P4 producer/contact/message scenario", async () => {
    const scenario = await loadScenario(scenarioPath);
    const result = await runScenario(scenario, {
      // Reuse the already-registered fake actor so its registration state persists.
      createActor: (): ScenarioCivilization => fake as unknown as ScenarioCivilization,
    });
    const contactAccepted = result.values.contactAccepted as { resourceId: string; duplicate?: boolean };
    const messageAccepted = result.values.messageAccepted as { resourceId: string; duplicate?: boolean };
    expect(contactAccepted?.resourceId).toBeTruthy();
    expect(messageAccepted?.resourceId).toBeTruthy();
    contactId = contactAccepted.resourceId;
    messageId = messageAccepted.resourceId;
  });

  // === 6. World creates relationship, public events, and two pending real-civ commands ===
  const pendingCommandIds: string[] = [];
  await test.step("world processing yields relationship, public events and two pending commands", async () => {
    // Interactions become authoritative (relationship + public events) during world processing.
    await pollUntil(
      async () => (await getJson<{ items: any[] }>(worldUrl("/world/v1/relationships"))).items,
      (items) =>
        items.some(
          (r) =>
            [r.pair?.civA, r.pair?.civB].includes(CIV_REAL) &&
            [r.pair?.civA, r.pair?.civB].includes(CIV_FAKE),
        ),
      { timeoutMs: 30_000, label: "relationship edge for the pair" },
    );
    await pollUntil(
      async () => (await getJson<{ items: any[] }>(worldUrl("/world/v1/events?limit=50"))).items,
      (items) => {
        const narratives = items.map((e) => e?.data?.publicNarrative);
        return narratives.includes(CONTACT_NARRATIVE) && narratives.includes(MESSAGE_NARRATIVE);
      },
      { timeoutMs: 30_000, label: "public contact + message events" },
    );

    // Observe the two pending commands as the real civ WITHOUT acknowledging them.
    const page1 = await pollUntil(
      async () => await realObserver.pullCommands(CIV_REAL, null, 50),
      (commands) => (commands.items?.length ?? 0) >= 2,
      { timeoutMs: 30_000, label: "two pending real-civ commands" },
    );
    for (const command of page1.items) pendingCommandIds.push(command.commandid);
    expect(pendingCommandIds.length).toBeGreaterThanOrEqual(2);
  });

  // === 7. Resume the real civ; P3 pulls, applies, ACKs and advances its cursor ===
  await test.step("real civ resumes, applies both commands, ACKs and advances cursor", async () => {
    await adminPost("/api/admin/federation/heartbeat");
    // Drive sync until both interactions reach the terminal acknowledged state.
    await pollUntil(
      async () => {
        await adminPost("/api/admin/federation/sync");
        const [contact, message] = await Promise.all([
          fake.getInteraction(contactId),
          fake.getInteraction(messageId),
        ]);
        return [contact.status, message.status];
      },
      (statuses) => statuses.every((s) => s === "acknowledged"),
      { timeoutMs: 45_000, label: "interactions acknowledged" },
    );

    // After successful ACKs the target has no more pullable commands.
    const drained = await realObserver.pullCommands(CIV_REAL, null, 50);
    expect(drained.items?.length ?? 0).toBe(0);
  });

  // === 8. Exactly-once: replay each ACK; assert stable duplicate + no repeated effects ===
  await test.step("ACK replay is idempotent and re-sync produces no new effects", async () => {
    const worldBefore = await getJson<any>(civUrl("/api/world"));
    const eventsBefore = worldBefore.recentEvents ?? [];
    const foreignBefore = countForeign(eventsBefore);
    expect(foreignBefore.contact).toBe(1);
    expect(foreignBefore.message).toBe(1);

    const ackBody: AckBody = { status: "applied", appliedAt: new Date().toISOString() } as AckBody;
    for (const commandId of pendingCommandIds) {
      // The P3 connector already acked each command. Replaying an ACK for an already-terminal
      // command (fresh idempotency key, so this is a genuine re-ACK not a cache hit) must report a
      // stable duplicate with the winning status and must not re-apply any effect.
      const replay = await realObserver.ackCommand(
        CIV_REAL,
        commandId,
        ackBody,
        `e2e-ack-replay:${commandId}`,
      );
      expect(replay.commandId).toBe(commandId);
      expect(replay.status).toBe("applied");
      expect(replay.duplicate).toBe(true);
    }

    // Re-sync the real civ: no repeated local effects.
    await adminPost("/api/admin/federation/sync");
    const worldAfter = await getJson<any>(civUrl("/api/world"));
    const foreignAfter = countForeign(worldAfter.recentEvents ?? []);
    expect(foreignAfter.contact).toBe(1);
    expect(foreignAfter.message).toBe(1);

    // Interactions and their public event narratives remain singular after the replays.
    const events = (await getJson<{ items: any[] }>(worldUrl("/world/v1/events?limit=100"))).items;
    expect(events.filter((e) => e?.data?.publicNarrative === CONTACT_NARRATIVE).length).toBe(1);
    expect(events.filter((e) => e?.data?.publicNarrative === MESSAGE_NARRATIVE).length).toBe(1);
  });

  // === 9. Real civ read model: registered/connected, known fake civ, briefing, local events ===
  await test.step("real civ /api/world exposes connected foreign affairs with no secrets", async () => {
    await adminPost("/api/admin/federation/heartbeat");
    const world = await pollUntil(
      async () => {
        await adminPost("/api/admin/federation/sync");
        return await getJson<any>(civUrl("/api/world"));
      },
      (w) => w.foreignAffairs?.registered === true && w.foreignAffairs?.connected === true,
      { timeoutMs: 30_000, label: "foreign affairs connected" },
    );
    expect((world.foreignAffairs.knownCivilizations ?? []).some((c: any) => c.civId === CIV_FAKE)).toBe(
      true,
    );
    expect(Array.isArray(world.foreignAffairs.briefing)).toBe(true);
    const briefing = (world.foreignAffairs.briefing as string[]).join("\n").toLowerCase();
    expect(briefing).toContain("contact");
    expect(briefing).toContain("message");

    const localEvents = countForeign(world.recentEvents ?? []);
    expect(localEvents.contact).toBe(1);
    expect(localEvents.message).toBe(1);

    const worldJson = JSON.stringify(world);
    for (const secret of allSecrets) expect(worldJson).not.toContain(secret);
  });

  // === 10. World public state: two civs, one edge, unique + forward-ordered events, data omitted ===
  await test.step("world public ledger is singular, ordered, and omits producer data", async () => {
    const civs = (await getJson<{ items: any[] }>(worldUrl("/world/v1/civilizations?limit=50"))).items;
    expect(civs.length).toBe(2);

    const relationships = (
      await getJson<{ items: any[] }>(worldUrl("/world/v1/relationships"))
    ).items.filter(
      (r) =>
        [r.pair?.civA, r.pair?.civB].includes(CIV_REAL) &&
        [r.pair?.civA, r.pair?.civB].includes(CIV_FAKE),
    );
    expect(relationships.length).toBe(1);
    expect(relationships[0].familiarity).toBeGreaterThan(0);

    const events = (await getJson<{ items: any[] }>(worldUrl("/world/v1/events?limit=100"))).items;
    // Producer event present exactly once, with its arbitrary producer data absent from the projection.
    const producer = events.filter((e) => e.type === "civ.turn.completed.v1");
    expect(producer.length).toBe(1);
    expect(producer[0].data == null || producer[0].data.secret === undefined).toBe(true);
    // The invalid-source event was rejected: nothing from civ_real's producer feed exists.
    expect(events.some((e) => e.id === "fake-evt-invalid-1")).toBe(false);
    // Unique ids and strictly forward-ordered world sequences.
    const ids = events.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const sequences = events.map((e) => Number(e.worldsequence));
    const sorted = [...sequences].sort((a, b) => a - b);
    expect(new Set(sequences).size).toBe(sequences.length);
    // The feed is returned in a stable order; assert monotonicity in whichever direction it is sorted.
    const ascending = sequences.every((v, i) => i === 0 || sequences[i - 1] <= v);
    const descending = sequences.every((v, i) => i === 0 || sequences[i - 1] >= v);
    expect(ascending || descending).toBe(true);
    expect(sequences).toEqual(ascending ? sorted : [...sorted].reverse());
  });

  // === 11. World Wire: real civ accounts/outbox, public reads, replies, desired state and cursors ===
  let realAgentAccountId: string;
  let realAgentLocalId: string;
  let realOfficialAccountId: string;
  let realPostId: string;
  let fakeAgentAccountId: string;
  let fakePostId: string;
  await test.step("World Wire account sync binds real agent and official accounts idempotently", async () => {
    // Let the real engine elect a President so the production sync plan contains its single official
    // account. Pause immediately afterwards; all social network work stays explicitly driven below.
    expect((await adminPost("/api/admin/start")).status).toBe(200);
    const civil = await pollUntil(
      async () => await getJson<any>(civUrl("/api/world")),
      (snapshot) => !!snapshot.simulation?.governance?.president,
      { timeoutMs: 30_000, intervalMs: 100, label: "real President elected" },
    );
    expect((await adminPost("/api/admin/pause")).status).toBe(200);

    const first = await adminPost("/api/admin/federation/social/sync");
    expect(first.status).toBe(200);
    const second = await adminPost("/api/admin/federation/social/sync");
    expect(second.status).toBe(200);
    expect(second.body.agentAccounts).toEqual(first.body.agentAccounts);
    expect(second.body.officialAccount).toEqual(first.body.officialAccount);
    expect(second.body.officialTermNumber).toBe(civil.simulation.governance.president.termNumber);

    realAgentLocalId = civil.simulation.governance.president.agentId as string;
    realAgentAccountId = first.body.agentAccounts[realAgentLocalId].accountId;
    realOfficialAccountId = first.body.officialAccount.accountId;
    expect(realAgentAccountId).toBeTruthy();
    expect(realOfficialAccountId).toBeTruthy();

    const fakeSync = await fake.syncSocialAccounts(
      {
        civId: CIV_FAKE,
        accounts: [
          {
            actor: { civId: CIV_FAKE, localAgentId: "fake_agent", displayName: "Fake Wire Agent", kind: "agent" },
          },
          {
            actor: { civId: CIV_FAKE, displayName: FAKE_DISPLAY_NAME, kind: "official" },
            officialAuthority: {
              presidentLocalAgentId: "fake_president",
              presidentDisplayName: "Fake President",
              termNumber: 1,
              authorityDecision: { mode: "president", ref: "fake-term-1" },
            },
          },
        ],
      },
      "fake-social-sync-1",
    );
    fakeAgentAccountId = fakeSync.accounts[0]!.accountId;
  });

  await test.step("real civ durable outbox posts to the public feed, events, stream and observer", async () => {
    const action = {
      op: "post",
      actingLocalAgentId: realAgentLocalId,
      useOfficialAccount: false,
      authorityMode: "citizen",
      authorityRef: "e2e-agent",
      idempotencyKey: "wire-real-post-1",
      text: "REAL-WIRE-POST: plain text from the durable civ outbox",
    };
    await enqueueSocialAction(action);
    // Replaying the local intent preserves one durable item rather than issuing a second mutation.
    await enqueueSocialAction(action);
    expect((await adminPost("/api/admin/federation/social/sync")).body.pendingOutbox).toBe(0);

    const post = await pollUntil<any>(
      async () => (await getJson<{ items: any[] }>(worldUrl("/world/v1/social/feed?limit=50"))).items
        .find((item) => item.text === action.text),
      (candidate) => candidate !== undefined,
      { timeoutMs: 30_000, label: "real civ post in public World Wire feed" },
    );
    realPostId = post.postId;
    expect(post.author.accountId).toBe(realAgentAccountId);

    const accountPosts = await getJson<{ items: any[] }>(
      worldUrl(`/world/v1/social/accounts/${encodeURIComponent(realAgentAccountId)}/posts?limit=50`),
    );
    expect(accountPosts.items.some((item) => item.postId === realPostId)).toBe(true);
    const events = await getJson<{ items: any[] }>(worldUrl("/world/v1/events?limit=100"));
    expect(events.items.some((event) => event.type === "world.social.post.created.v1" && event.data?.post?.postId === realPostId)).toBe(true);
    const sse = await readSseUntil(worldUrl("/world/v1/stream"), {
      windowMs: 2_500,
      matchFrame: (frame) => frame.includes("world.social."),
    });
    expect(sse.contentType).toContain("text/event-stream");
    expect(
      sse.matched,
      `social SSE frame was not observed; stop=${sse.stopReason}; error=${sse.error ?? "none"}; frames=${sse.raw}`,
    ).toBe(true);
  });

  await test.step("fake reply reaches the real civ briefing and direct-reply awareness", async () => {
    const reply = await fake.createSocialPost(
      {
        authorAccountId: fakeAgentAccountId,
        text: "FAKE-WIRE-REPLY: citizen-safe reply for the real President",
        parentPostId: realPostId,
        authorization: { actingLocalAgentId: "fake_agent", authorityDecision: { mode: "citizen", ref: "fake-agent" } },
      },
      "fake-wire-reply-1",
    );
    expect(reply.parentPostId).toBe(realPostId);

    const thread = await fake.getSocialThread(realPostId, { limit: 50 });
    expect(thread.items.map((item: { postId: string }) => item.postId)).toEqual([realPostId, reply.postId]);
    expect(thread.items[1]?.replyDepth).toBe(1);

    const social = (await adminPost("/api/admin/federation/social/sync")).body;
    expect(JSON.stringify(social.briefing)).toContain("FAKE-WIRE-REPLY");
    expect(JSON.stringify(social)).not.toMatch(/memory|model|authorityDecision|onboarding|hmac/i);

    expect((await adminPost("/api/admin/start")).status).toBe(200);
    await pollUntil(
      async () => await getJson<any>(civUrl("/api/world")),
      (snapshot) => snapshot.agents.some((agent: any) =>
        agent.memorySummaries?.some((memory: string) => memory.includes("FAKE-WIRE-REPLY"))),
      { timeoutMs: 30_000, intervalMs: 100, label: "real civ surfaces direct reply once" },
    );
    expect((await adminPost("/api/admin/pause")).status).toBe(200);
  });

  await test.step("likes and follows converge to the newest desired state with safe no-ops", async () => {
    const intent = (op: "like" | "follow", key: string, desired: boolean) => ({
      op,
      actingLocalAgentId: realAgentLocalId,
      useOfficialAccount: false,
      authorityMode: "citizen",
      authorityRef: "e2e-agent",
      idempotencyKey: key,
      ...(op === "like"
        ? { targetPostId: realPostId, liked: desired }
        : { targetAccountId: fakeAgentAccountId, following: desired }),
    });

    await enqueueSocialAction(intent("like", "wire-like-true", true));
    await enqueueSocialAction(intent("like", "wire-like-true-replay", true));
    expect((await adminPost("/api/admin/federation/social/sync")).status).toBe(200);
    expect((await getJson<any>(worldUrl(`/world/v1/social/posts/${realPostId}`))).likeCount).toBe(1); // self-like is allowed.
    await enqueueSocialAction(intent("like", "wire-like-false", false));

    await enqueueSocialAction(intent("follow", "wire-follow-true", true));
    await enqueueSocialAction(intent("follow", "wire-follow-true-replay", true));
    await enqueueSocialAction(intent("follow", "wire-follow-false", false));
    expect((await adminPost("/api/admin/federation/social/sync")).status).toBe(200);

    const post = await getJson<any>(worldUrl(`/world/v1/social/posts/${realPostId}`));
    const account = await getJson<any>(worldUrl(`/world/v1/social/accounts/${realAgentAccountId}`));
    expect(post.likeCount).toBe(0);
    expect(account.followingCount).toBe(0);

    const selfFollow = await adminPost("/api/admin/federation/social/actions", {
      ...intent("follow", "wire-self-follow", true),
      targetAccountId: realAgentAccountId,
    });
    expect(selfFollow.status).toBe(409);
    expect(selfFollow.body).toEqual({ ok: false, reason: "invalid" });
  });

  await test.step("tombstones, snapshots and cursor mismatches preserve public ordering safely", async () => {
    const originalText = "FAKE-WIRE-TOMBSTONE: text that must be withdrawn";
    const created = await fake.createSocialPost(
      {
        authorAccountId: fakeAgentAccountId,
        text: originalText,
        authorization: { actingLocalAgentId: "fake_agent", authorityDecision: { mode: "citizen", ref: "fake-agent" } },
      },
      "fake-wire-tombstone-create",
    );
    fakePostId = created.postId;
    const firstPage = await getJson<{ items: any[]; nextCursor: string | null }>(worldUrl("/world/v1/social/feed?limit=1"));
    expect(firstPage.nextCursor).toBeTruthy();
    const late = await fake.createSocialPost(
      {
        authorAccountId: fakeAgentAccountId,
        text: "FAKE-WIRE-LATE-POST: excluded from the existing cursor snapshot",
        authorization: { actingLocalAgentId: "fake_agent", authorityDecision: { mode: "citizen", ref: "fake-agent" } },
      },
      "fake-wire-late-post",
    );
    const continued = await getJson<{ items: any[] }>(
      worldUrl(`/world/v1/social/feed?limit=50&cursor=${encodeURIComponent(firstPage.nextCursor!)}`),
    );
    expect(continued.items.some((item) => item.postId === late.postId)).toBe(false);
    const mismatch = await fetch(
      worldUrl(`/world/v1/social/accounts/${encodeURIComponent(realAgentAccountId)}/posts?cursor=${encodeURIComponent(firstPage.nextCursor!)}`),
    );
    expect(mismatch.status).toBe(400);

    const tombstoned = await fake.tombstoneSocialPost(
      fakePostId,
      { authorization: { actingLocalAgentId: "fake_agent", authorityDecision: { mode: "citizen", ref: "fake-agent" } } },
      "fake-wire-tombstone",
    );
    expect(tombstoned.status).toBe("tombstoned");
    // The runtime omits nullable terminal text rather than serializing `null`; both forms satisfy the
    // contract, but this E2E pins the live API shape so a future client cannot mistake omission for text.
    expect(tombstoned.text).toBeUndefined();
    expect(tombstoned.worldsequence).toBe(created.worldsequence);
    expect((await fake.getSocialPost(fakePostId)).text).toBeUndefined();
    const thread = await fake.getSocialThread(fakePostId, { limit: 50 });
    expect(JSON.stringify(thread)).not.toContain(originalText);
    const tombstoneEvent = (await getJson<{ items: any[] }>(worldUrl("/world/v1/events?limit=100"))).items
      .find((event) => event.type === "world.social.post.tombstoned.v1" && event.data?.postId === fakePostId);
    expect(tombstoneEvent).toBeDefined();
    expect(JSON.stringify(tombstoneEvent)).not.toContain(originalText);
  });

  // === 12. Observer: names, relationship detail, timeline once, SSE resumable + reconnect ===
  await test.step("observer renders civs, relationship, timeline and a resumable SSE feed", async () => {
    // Reload so the SPA recovers the full durable state from /events (no duplicate timeline entries).
    await page.reload();
    // Civilization names are visible as interactive nodes/list entries (not just SVG tooltips).
    await expect(
      page.getByRole("button", { name: new RegExp(REAL_DISPLAY_NAME) }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole("button", { name: new RegExp(FAKE_DISPLAY_NAME) }).first(),
    ).toBeVisible();

    // Timeline narratives each appear exactly once.
    await expect(page.getByText(CONTACT_NARRATIVE)).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByText(MESSAGE_NARRATIVE)).toHaveCount(1);

    // Relationship edge is rendered for the pair; open its detail and confirm familiarity is shown.
    const edgeLabel = page
      .getByText(
        new RegExp(`${FAKE_DISPLAY_NAME}\\s+and\\s+${REAL_DISPLAY_NAME}|${REAL_DISPLAY_NAME}\\s+and\\s+${FAKE_DISPLAY_NAME}`),
      )
      .first();
    await expect(edgeLabel).toBeAttached();
    await edgeLabel.locator("xpath=..").click({ force: true });
    await expect(page.getByText(/Familiarity/i).first()).toBeVisible();

    // SSE probe: the stream connects, returns text/event-stream, and carries resumable id: frames.
    const sse = await readSseUntil(worldUrl("/world/v1/stream"), {
      windowMs: 2_500,
      matchFrame: (frame) => /^id:/m.test(frame),
    });
    expect(sse.contentType).toContain("text/event-stream");
    expect(
      sse.matched,
      `resumable SSE frame was not observed; stop=${sse.stopReason}; error=${sse.error ?? "none"}; frames=${sse.raw}`,
    ).toBe(true);
    capturedBodies.push(sse.raw);

    // Reload again = reconnect from the durable feed; still exactly one of each narrative.
    await page.reload();
    await expect(page.getByText(CONTACT_NARRATIVE)).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByText(MESSAGE_NARRATIVE)).toHaveCount(1);
    await expect(page.getByRole("status").first()).toContainText(/Live|Offline|Reconnecting/i);

    // No unexpected browser/network faults occurred while observing public surfaces.
    expect(pageErrors, `page errors: ${pageErrors.join("; ")}`).toHaveLength(0);
    expect(failedRequests, `failed requests: ${failedRequests.join("; ")}`).toHaveLength(0);
    expect(badPublicResponses, `non-2xx public responses: ${badPublicResponses.join("; ")}`).toHaveLength(
      0,
    );
    expect(consoleErrors, `console errors: ${consoleErrors.join("; ")}`).toHaveLength(0);
  });

  // === 13. Observer World Wire: deep-linked public text only, with no mutation controls ===
  await test.step("observer renders the deep-linked World Wire post as plain text", async () => {
    await page.goto(worldUrl(`/#wire=post/${encodeURIComponent(realPostId)}`));
    await expect(page.getByRole("article", { name: /Post by/ }).filter({ hasText: "REAL-WIRE-POST" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("REAL-WIRE-POST: plain text from the durable civ outbox")).toBeVisible();
    await expect(page.getByRole("article", { name: /Post by/ }).filter({ hasText: "REAL-WIRE-POST" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    const controls = await page.getByRole("button").allTextContents();
    expect(controls.join(" ").toLowerCase()).not.toMatch(/\b(like|unlike|follow|unfollow|delete|publish)\b/);
  });

  // === 14. Privacy scan: no credential or private-payload sentinel on any public surface ===
  await test.step("no secrets or private payloads leak to any public surface", async () => {
    const publicBodies = await Promise.all([
      fetch(worldUrl("/world/v1/civilizations?limit=50")).then((r) => r.text()),
      fetch(worldUrl("/world/v1/relationships")).then((r) => r.text()),
      fetch(worldUrl("/world/v1/events?limit=100")).then((r) => r.text()),
      fetch(worldUrl(`/world/v1/civilizations/${CIV_REAL}`)).then((r) => r.text()),
      fetch(worldUrl(`/world/v1/civilizations/${CIV_FAKE}`)).then((r) => r.text()),
      fetch(worldUrl("/world/v1/social/feed?limit=100")).then((r) => r.text()),
      fetch(worldUrl(`/world/v1/social/posts/${encodeURIComponent(realPostId)}`)).then((r) => r.text()),
      fetch(worldUrl(`/world/v1/social/posts/${encodeURIComponent(fakePostId)}/thread?limit=100`)).then((r) => r.text()),
      fetch(worldUrl(`/world/v1/social/accounts/${encodeURIComponent(realAgentAccountId)}`)).then((r) => r.text()),
    ]);
    const domText = (await page.locator("body").innerText()) ?? "";
    const diagnostics = [world?.log.tail(80) ?? "", civ?.log.tail(80) ?? ""].join("\n");

    const haystacks: Array<[string, string]> = [
      ...publicBodies.map((b, i) => [`public-body-${i}`, b] as [string, string]),
      ["captured-response-bodies", capturedBodies.join("\n")],
      ["observer-dom", domText],
      ["process-diagnostics", diagnostics],
    ];
    const forbidden = [...allSecrets, ...privateSentinels()];
    for (const [label, hay] of haystacks) {
      for (const needle of forbidden) {
        expect(hay.includes(needle), `sentinel leaked into ${label}`).toBe(false);
      }
      expect(hay).not.toMatch(/world_hmac|onboardingtoken|authoritydecision|presidentlocalagentid|memorysummaries|model/i);
    }
  });
});

function countForeign(events: Array<{ type?: string }>): { contact: number; message: number } {
  return {
    contact: events.filter((e) => e.type === "foreignContactReceived").length,
    message: events.filter((e) => e.type === "foreignMessageReceived").length,
  };
}
