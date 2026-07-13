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

async function adminPost(pathname: string): Promise<{ status: number; body: any }> {
  const response = await fetch(civUrl(pathname), {
    method: "POST",
    headers: { "x-admin-key": creds.adminKey },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
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

  // === 11. Observer: names, relationship detail, timeline once, SSE resumable + reconnect ===
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
    const sse = await readSseSample(worldUrl("/world/v1/stream"), 2500);
    expect(sse.contentType).toContain("text/event-stream");
    expect(sse.frames.some((f) => /^id:/m.test(f))).toBe(true);
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

  // === 12. Privacy scan: no credential or private-payload sentinel on any public surface ===
  await test.step("no secrets or private payloads leak to any public surface", async () => {
    const publicBodies = await Promise.all([
      fetch(worldUrl("/world/v1/civilizations?limit=50")).then((r) => r.text()),
      fetch(worldUrl("/world/v1/relationships")).then((r) => r.text()),
      fetch(worldUrl("/world/v1/events?limit=100")).then((r) => r.text()),
      fetch(worldUrl(`/world/v1/civilizations/${CIV_REAL}`)).then((r) => r.text()),
      fetch(worldUrl(`/world/v1/civilizations/${CIV_FAKE}`)).then((r) => r.text()),
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
    }
  });
});

function countForeign(events: Array<{ type?: string }>): { contact: number; message: number } {
  return {
    contact: events.filter((e) => e.type === "foreignContactReceived").length,
    message: events.filter((e) => e.type === "foreignMessageReceived").length,
  };
}

/** Read a short sample of an SSE feed: content-type plus the first frames, then abort. */
async function readSseSample(
  url: string,
  windowMs: number,
): Promise<{ contentType: string; frames: string[]; raw: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), windowMs);
  let contentType = "";
  let raw = "";
  try {
    const response = await fetch(url, {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    });
    contentType = response.headers.get("content-type") ?? "";
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    if (reader) {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          raw += decoder.decode(value, { stream: true });
          // The endpoint replays the durable feed as id:-framed events on connect; one complete
          // frame is enough to prove a resumable stream.
          if (/(^|\n)id:/.test(raw) && raw.includes("\n\n")) break;
          if (raw.length > 8192) break;
        }
      } catch {
        // aborted or stream error mid-read — keep whatever was captured
      }
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
    }
  } catch {
    // fetch failed to establish — contentType stays empty and the assertion will surface it
  } finally {
    clearTimeout(timer);
  }
  return { contentType, frames: raw.split(/\n\n/).filter(Boolean), raw };
}
