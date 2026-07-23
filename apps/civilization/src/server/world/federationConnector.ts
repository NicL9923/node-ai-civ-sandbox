// Background World connector: civ-initiated register / heartbeat / outbox-flush / command-pull loops.
// Every loop is guarded against re-entrancy and wrapped so World downtime never throws into the turn
// engine. Retries are driven by the periodic schedule plus per-item backoff; idempotency keys are
// stable across attempts. The command cursor is advanced ONLY after every command on a page is acked.
import type { FederationConfig } from "../config.js";
import type { FederationService, AckDecision } from "./federationService.js";
import type { SocialService } from "./socialService.js";
import type { CloudEvent, Command, InteractionRequest, OutboxItemDoc, PublicProjection, SocialOutboxPayload } from "./federationTypes.js";
import { createWorldClient, type WorldClient, type WorldSigner } from "./worldClient.js";

const BACKOFF_BASE_MS = 2_000;
const BACKOFF_CAP_MS = 60_000;
const PULL_PAGE_LIMIT = 50;

type LoopName = "heartbeat" | "poll" | "flush" | "socialSync" | "socialFeed";

interface ClassifiedError extends Error {
  retryable: boolean;
  status?: number;
  /** Parsed from a 429 Retry-After header (ms), bounded by the caller. */
  retryAfterMs?: number;
}

export class FederationConnector {
  private static readonly DIR_PAGE_LIMIT = 100;
  private static readonly DIR_MAX_PAGES = 50;
  private static readonly DIR_MAX_ITEMS = 5_000;

  private client: WorldClient;
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly inFlight: Record<LoopName, boolean> = {
    heartbeat: false,
    poll: false,
    flush: false,
    socialSync: false,
    socialFeed: false
  };
  private stopped = false;

  constructor(
    private readonly service: FederationService,
    private readonly config: FederationConfig,
    private readonly log: (message: string, error?: unknown) => void = (message, error) =>
      error ? console.error(`[federation] ${message}`, error) : console.log(`[federation] ${message}`),
    private readonly social?: SocialService
  ) {
    // Build a signed client immediately when credentials are pre-provisioned; the onboarding flow
    // rebuilds it after registration assigns civId/keyId (see rebuildClient).
    this.client = createWorldClient(config.apiBaseUrl, this.buildSigner(config.civId, config.keyId));
  }

  async start(): Promise<void> {
    const state = await this.service.ensureState();

    // Auto-registration is limited to the bootstrap case: no credentials yet but an onboarding token
    // is configured. Pre-provisioned civs skip this; explicit re-registration is an admin action.
    if (!state.registered && this.config.onboardingToken) {
      try {
        await this.register();
      } catch (error) {
        this.log("initial registration failed (will retry via admin/heartbeat)", error);
      }
    }

    await this.rebuildClient();
    // Kick an immediate sync so status is fresh without waiting a full interval.
    void this.runLoop("heartbeat", () => this.heartbeat());
    void this.runLoop("poll", () => this.pollAndAck());

    this.timers.push(
      setInterval(() => void this.runLoop("heartbeat", () => this.heartbeat()), this.config.heartbeatIntervalMs).unref(),
      setInterval(() => void this.runLoop("poll", () => this.pollAndAck()), this.config.pollIntervalMs).unref(),
      setInterval(() => void this.runLoop("flush", () => this.flushOutbox()), this.config.outboxIntervalMs).unref()
    );

    // World Wire (social) loops are additive and only run when the social sub-feature is enabled.
    if (this.social && this.config.social.enabled) {
      void this.runLoop("socialSync", () => this.syncSocialAccounts());
      void this.runLoop("socialFeed", () => this.pollSocialFeed());
      this.timers.push(
        setInterval(() => void this.runLoop("socialSync", () => this.syncSocialAccounts()), this.config.social.syncIntervalMs).unref(),
        setInterval(() => void this.runLoop("socialFeed", () => this.pollSocialFeed()), this.config.social.feedIntervalMs).unref()
      );
    }
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.timers.length = 0;
  }

  /** Explicit registration via the onboarding token (used at bootstrap and by the admin route). */
  async register(): Promise<void> {
    if (!this.config.onboardingToken) {
      throw new Error("Cannot register: no WORLD_ONBOARDING_TOKEN configured.");
    }
    const unsigned = createWorldClient(this.config.apiBaseUrl);
    const { data, error, response } = await unsigned.POST("/civilizations/register", {
      params: { header: { "Idempotency-Key": `register:${this.config.displayName}` } },
      body: {
        onboardingToken: this.config.onboardingToken,
        displayName: this.config.displayName,
        capabilities: {
          protocolVersion: `${this.config.protocolVersion}.0.0`,
          supportedInteractionKinds: ["contact", "message"],
          maxEventBatchSize: 1
        }
      }
    });
    if (error || !data) {
      throw this.httpError(response, error);
    }

    const state = await this.service.getState();
    state.civId = data.civId;
    state.keyId = data.keyId;
    state.registered = true;
    state.registeredAt = data.registeredAt;
    if (data.commandsCursor !== undefined) {
      state.commandCursor = data.commandsCursor;
    }
    await this.service.saveState(state);
    await this.service.recordLocalForeignEvent("foreignRegistered", `Registered with the World as ${data.civId}.`);
    await this.rebuildClient();
  }

  async heartbeat(): Promise<void> {
    const state = await this.service.getState();
    if (!state.civId) {
      return;
    }
    const projection = await this.service.buildProjection();
    const { error, response } = await this.client.POST("/civilizations/{civId}/heartbeat", {
      params: { path: { civId: state.civId }, header: this.authHeader() },
      body: { projection, lastProcessedWorldCursor: state.commandCursor ?? null }
    });
    if (error) {
      throw this.httpError(response, error);
    }
    await this.service.markConnection(true);
    // A directory refresh failure must not undo a successful heartbeat's connectivity or block the
    // loop: keep the last-known directory and carry on.
    try {
      await this.refreshDirectory();
    } catch (error) {
      this.log("directory refresh failed; keeping last-known directory", error);
    }
  }

  /**
   * Refresh the cached civ directory from the public projection feed, following `nextCursor` until it
   * is null. Bounded by MAX pages/items with repeated-cursor cycle detection. The cache is replaced
   * only after EVERY page succeeds; any page failure or cycle throws/aborts and preserves the last-known
   * directory (never a partial overwrite).
   */
  async refreshDirectory(): Promise<void> {
    const all: PublicProjection[] = [];
    const seenCursors = new Set<string>();
    let after: string | undefined;

    for (let page = 0; page < FederationConnector.DIR_MAX_PAGES; page += 1) {
      const { data, error, response } = await this.client.GET("/civilizations", {
        params: { query: { after, limit: FederationConnector.DIR_PAGE_LIMIT } }
      });
      if (error || !data) {
        throw this.httpError(response, error);
      }
      all.push(...data.items);
      if (all.length > FederationConnector.DIR_MAX_ITEMS) {
        this.log(`directory refresh exceeded ${FederationConnector.DIR_MAX_ITEMS} items; preserving cache`);
        return;
      }
      const next = data.nextCursor ?? undefined;
      if (!next) {
        // Caught up: every page succeeded, so it is safe to replace the cache.
        await this.service.refreshDirectory(all);
        return;
      }
      if (seenCursors.has(next)) {
        this.log("directory cursor cycle detected; preserving cache");
        return;
      }
      seenCursors.add(next);
      after = next;
    }
    this.log(`directory refresh hit the ${FederationConnector.DIR_MAX_PAGES}-page cap; preserving cache`);
  }

  async pollAndAck(): Promise<void> {
    const state = await this.service.getState();
    if (!state.civId) {
      return;
    }
    const { data, error, response } = await this.client.GET("/civilizations/{civId}/commands", {
      params: {
        path: { civId: state.civId },
        query: { after: state.commandCursor ?? undefined, limit: PULL_PAGE_LIMIT },
        header: this.authHeader()
      }
    });
    if (error || !data) {
      throw this.httpError(response, error);
    }
    await this.service.markConnection(true);

    // Apply then ACK each command. The cursor is advanced only after the whole page is acked; a failure
    // mid-page leaves the cursor put, so the next cycle re-pulls and the dedupe layer makes it a no-op.
    for (const command of data.items) {
      const decision = await this.service.applyInboundCommand(command);
      await this.ackCommand(state.civId, command.commandid, decision);
    }

    // Advance the cursor ONLY to a real next cursor. A null nextCursor means "caught up" — keep the
    // current position rather than resetting to the beginning (Cursor has minLength 1, so a truthy
    // check cleanly excludes both null and undefined). The advance is serialized in the service.
    if (data.nextCursor) {
      await this.service.advanceCursor(data.nextCursor);
    }
  }

  private async ackCommand(civId: string, commandId: string, decision: AckDecision): Promise<void> {
    const { error, response } = await this.client.POST("/civilizations/{civId}/commands/{commandId}/ack", {
      params: { path: { civId, commandId }, header: this.idemHeader(`ack:${commandId}`) },
      body: { status: decision.status, detail: decision.detail }
    });
    if (error) {
      throw this.httpError(response, error);
    }
  }

  async flushOutbox(): Promise<void> {
    // Process oldest-first with a deterministic tie-break so causal (FIFO) order is well-defined
    // regardless of store ordering. Social like/follow are DESIRED-STATE PUTs: a newer intent for the
    // same target must never overtake an older, not-yet-delivered one, or the final World state could
    // regress to the older value (e.g. like=true 429s and backs off, like=false sends, then the true
    // retry lands last ⇒ final=true, the opposite of the newest intent). We therefore preserve FIFO PER
    // desired-state target key while letting posts and unrelated targets progress independently.
    const items = [...(await this.service.listPendingOutbox())].sort(compareFifo);
    const now = Date.now();
    const blockedKeys = new Set<string>();

    for (const item of items) {
      const key = desiredStateKey(item);
      // A newer same-target intent is held behind an older one that has not yet been delivered.
      if (key && blockedKeys.has(key)) {
        continue;
      }
      if (item.nextAttemptAt && new Date(item.nextAttemptAt).getTime() > now) {
        // An older not-yet-due item owns this target; every newer same-key intent must wait.
        if (key) {
          blockedKeys.add(key);
        }
        continue;
      }
      try {
        if (item.itemKind === "event") {
          await this.sendEvent(item);
        } else if (item.itemKind === "social") {
          await this.sendSocial(item);
        } else {
          await this.sendInteraction(item);
        }
        item.status = "sent";
        item.lastError = undefined;
        await this.service.saveOutboxItem(item);
        await this.service.markConnection(true);
        // Success: the target is up to date, so a newer same-key intent may send later THIS cycle in
        // FIFO order (the key is intentionally left unblocked).
      } catch (error) {
        item.attempts += 1;
        item.lastError = error instanceof Error ? error.message : String(error);
        if (this.isRetryable(error)) {
          // Honor a bounded 429 Retry-After when the World advertised one; otherwise use normal backoff.
          const retryAfterMs = this.retryAfterMsOf(error);
          item.nextAttemptAt = retryAfterMs !== undefined ? this.retryAfterAt(retryAfterMs) : this.backoffAt(item.attempts);
          // Retryable failure: the older intent is still live, so hold newer same-key intents this cycle.
          if (key) {
            blockedKeys.add(key);
          }
        } else {
          item.status = "failed";
          this.log(`outbox item ${item.id} permanently failed`, error);
          // Permanent failure: the old request can NEVER apply, so a newer same-key intent may proceed.
        }
        await this.service.saveOutboxItem(item);
      }
    }
  }

  private async sendEvent(item: OutboxItemDoc): Promise<void> {
    const state = await this.service.getState();
    if (!state.civId) {
      throw this.permanentError("no civId; cannot send events");
    }
    const { error, response } = await this.client.POST("/civilizations/{civId}/events/batch", {
      params: { path: { civId: state.civId }, header: this.idemHeader(item.idempotencyKey) },
      body: { events: [item.payload as CloudEvent] }
    });
    if (error) {
      throw this.httpError(response, error);
    }
  }

  private async sendInteraction(item: OutboxItemDoc): Promise<void> {
    const { data, error, response } = await this.client.POST("/interactions", {
      params: { header: this.idemHeader(item.idempotencyKey) },
      body: item.payload as InteractionRequest
    });
    if (error) {
      throw this.httpError(response, error);
    }
    if (data?.resourceId) {
      item.interactionId = data.resourceId;
    }
  }

  /** Flush one durable World Wire mutation. World is authoritative — social facts are NEVER re-exported. */
  private async sendSocial(item: OutboxItemDoc): Promise<void> {
    if (!this.social) {
      throw this.permanentError("social item present but social sub-feature is disabled");
    }
    const payload = item.payload as SocialOutboxPayload;
    if (payload.op === "post") {
      const { error, response } = await this.client.POST("/social/posts", {
        params: { header: this.idemHeader(item.idempotencyKey) },
        body: {
          authorAccountId: payload.authorAccountId,
          text: payload.text,
          parentPostId: payload.parentPostId,
          authorization: payload.authorization
        }
      });
      if (error) {
        throw this.httpError(response, error);
      }
      return;
    }
    if (payload.op === "like") {
      const { error, response } = await this.client.PUT("/social/posts/{postId}/likes/{accountId}", {
        params: { path: { postId: payload.postId, accountId: payload.accountId }, header: this.idemHeader(item.idempotencyKey) },
        body: { liked: payload.liked, authorization: payload.authorization }
      });
      if (error) {
        throw this.httpError(response, error);
      }
      return;
    }
    // follow
    const { error, response } = await this.client.PUT("/social/accounts/{accountId}/following/{targetAccountId}", {
      params: {
        path: { accountId: payload.followerAccountId, targetAccountId: payload.targetAccountId },
        header: this.idemHeader(item.idempotencyKey)
      },
      body: { following: payload.following, authorization: payload.authorization }
    });
    if (error) {
      throw this.httpError(response, error);
    }
    await this.social.recordFollowResult(payload.followerAccountId, payload.targetAccountId, payload.following);
  }

  /**
   * Reconcile the civ's World Wire accounts. Debounced + fingerprint-gated in the service, so an
   * unchanged desired set is a no-op. The ordered response is zipped back onto local identities.
   */
  async syncSocialAccounts(): Promise<void> {
    if (!this.social) {
      return;
    }
    const plan = await this.social.buildSyncPlan();
    if (!plan || !(await this.social.shouldSync(plan.fingerprint))) {
      return;
    }
    const { data, error, response } = await this.client.POST("/social/accounts/sync", {
      params: { header: this.idemHeader(this.social.syncIdempotencyKey(plan.fingerprint)) },
      body: plan.request
    });
    if (error || !data) {
      throw this.httpError(response, error);
    }
    await this.social.applySyncResult(plan.slots, data.accounts, plan.fingerprint);
    await this.service.markConnection(true);
  }

  /** Poll the public global feed (first-page snapshot) and compact-merge it into the bounded cache. */
  async pollSocialFeed(): Promise<void> {
    if (!this.social) {
      return;
    }
    const { data, error, response } = await this.client.GET("/social/feed", {
      params: { query: { limit: this.config.social.feedLimit } }
    });
    if (error || !data) {
      throw this.httpError(response, error);
    }
    await this.social.applyFeedPage(data.items);
  }

  // --- helpers ---------------------------------------------------------------

  private async rebuildClient(): Promise<void> {
    const state = await this.service.getState();
    this.client = createWorldClient(this.config.apiBaseUrl, this.buildSigner(state.civId, state.keyId));
  }

  private buildSigner(civId?: string, keyId?: string): WorldSigner | undefined {
    if (civId && keyId && this.config.hmacSecret) {
      return { civId, keyId, secret: this.config.hmacSecret, protocolVersion: this.config.protocolVersion };
    }
    return undefined;
  }

  private async runLoop(name: LoopName, fn: () => Promise<void>): Promise<void> {
    if (this.stopped || this.inFlight[name]) {
      return;
    }
    this.inFlight[name] = true;
    try {
      await fn();
    } catch (error) {
      this.log(`${name} cycle failed (World may be unreachable)`, error);
      await this.service.markConnection(false).catch(() => undefined);
    } finally {
      this.inFlight[name] = false;
    }
  }

  /**
   * Placeholder HMAC headers for authenticated calls. Real values are computed and overwritten by the
   * signing middleware in worldClient.ts; these satisfy the generated types and carry the stable
   * Idempotency-Key (field 6 of the canonical string).
   */
  private idemHeader(idempotencyKey: string) {
    return { ...this.authHeader(), "Idempotency-Key": idempotencyKey };
  }

  private authHeader() {
    return {
      "X-Protocol-Version": this.config.protocolVersion,
      "X-Civ-Id": "",
      "X-Key-Id": "",
      "X-Timestamp": "",
      "X-Nonce": "",
      "X-Signature": ""
    };
  }

  private backoffAt(attempts: number): string {
    const raw = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
    const jittered = raw * (0.8 + Math.random() * 0.4);
    return new Date(Date.now() + jittered).toISOString();
  }

  /** A bounded next-attempt time from a 429 Retry-After hint (clamped to the social maxRetryAfterMs). */
  private retryAfterAt(retryAfterMs: number): string {
    const bounded = Math.max(0, Math.min(retryAfterMs, this.config.social.maxRetryAfterMs));
    return new Date(Date.now() + bounded).toISOString();
  }

  private retryAfterMsOf(error: unknown): number | undefined {
    if (typeof error === "object" && error !== null && "retryAfterMs" in error) {
      const value = (error as ClassifiedError).retryAfterMs;
      return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    }
    return undefined;
  }

  private isRetryable(error: unknown): boolean {
    return !(typeof error === "object" && error !== null && "retryable" in error && (error as ClassifiedError).retryable === false);
  }

  private permanentError(message: string): ClassifiedError {
    const error = new Error(message) as ClassifiedError;
    error.retryable = false;
    return error;
  }

  /** Classify an openapi-fetch error response. 4xx (except 429) is permanent; 429/5xx/network retryable. */
  private httpError(response: Response | undefined, error: unknown): ClassifiedError {
    const status = response?.status;
    const detail = this.problemDetail(error);
    const err = new Error(`World call failed${status ? ` (HTTP ${status})` : ""}${detail ? `: ${detail}` : ""}`) as ClassifiedError;
    err.status = status;
    err.retryable = status === undefined || status === 429 || status >= 500;
    if (status === 429) {
      err.retryAfterMs = parseRetryAfterMs(response?.headers.get("Retry-After"));
    }
    return err;
  }

  private problemDetail(error: unknown): string | undefined {
    if (error && typeof error === "object") {
      const problem = error as { detail?: unknown; title?: unknown; code?: unknown };
      const value = problem.detail ?? problem.title ?? problem.code;
      if (typeof value === "string") {
        return value;
      }
    }
    return undefined;
  }
}

/** Parse an HTTP `Retry-After` header (delta-seconds or an HTTP-date) into milliseconds. */
function parseRetryAfterMs(header: string | null | undefined): number | undefined {
  if (!header) {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

/** Deterministic FIFO order for the outbox: oldest createdAt first, id as a stable tie-breaker. */
function compareFifo(a: OutboxItemDoc, b: OutboxItemDoc): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? -1 : 1;
  }
  return a.id.localeCompare(b.id);
}

/**
 * The desired-state target key for a social like/follow (whose final value depends on delivery order),
 * or undefined for order-independent items (posts, events, interactions). FIFO is enforced only within a
 * key so unrelated targets and posts still progress freely.
 */
function desiredStateKey(item: OutboxItemDoc): string | undefined {
  if (item.itemKind !== "social") {
    return undefined;
  }
  const payload = item.payload as SocialOutboxPayload;
  if (payload.op === "like") {
    return `like:${payload.accountId}:${payload.postId}`;
  }
  if (payload.op === "follow") {
    return `follow:${payload.followerAccountId}:${payload.targetAccountId}`;
  }
  return undefined;
}