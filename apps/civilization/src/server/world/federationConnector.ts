// Background World connector: civ-initiated register / heartbeat / outbox-flush / command-pull loops.
// Every loop is guarded against re-entrancy and wrapped so World downtime never throws into the turn
// engine. Retries are driven by the periodic schedule plus per-item backoff; idempotency keys are
// stable across attempts. The command cursor is advanced ONLY after every command on a page is acked.
import type { FederationConfig } from "../config.js";
import type { FederationService, AckDecision } from "./federationService.js";
import type { CloudEvent, Command, InteractionRequest, OutboxItemDoc } from "./federationTypes.js";
import { createWorldClient, type WorldClient, type WorldSigner } from "./worldClient.js";

const BACKOFF_BASE_MS = 2_000;
const BACKOFF_CAP_MS = 60_000;
const PULL_PAGE_LIMIT = 50;

type LoopName = "heartbeat" | "poll" | "flush";

interface ClassifiedError extends Error {
  retryable: boolean;
  status?: number;
}

export class FederationConnector {
  private client: WorldClient;
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly inFlight: Record<LoopName, boolean> = { heartbeat: false, poll: false, flush: false };
  private stopped = false;

  constructor(
    private readonly service: FederationService,
    private readonly config: FederationConfig,
    private readonly log: (message: string, error?: unknown) => void = (message, error) =>
      error ? console.error(`[federation] ${message}`, error) : console.log(`[federation] ${message}`)
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
    await this.refreshDirectory();
  }

  /** Refresh the cached civ directory from the public (unauthenticated) projection feed. */
  async refreshDirectory(): Promise<void> {
    const { data } = await this.client.GET("/civilizations", { params: { query: { limit: 100 } } });
    if (data?.items) {
      await this.service.refreshDirectory(data.items);
    }
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
    // check cleanly excludes both null and undefined).
    if (data.nextCursor) {
      const latest = await this.service.getState();
      latest.commandCursor = data.nextCursor;
      await this.service.saveState(latest);
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
    const items = await this.service.listPendingOutbox();
    const now = Date.now();
    for (const item of items) {
      if (item.nextAttemptAt && new Date(item.nextAttemptAt).getTime() > now) {
        continue;
      }
      try {
        if (item.itemKind === "event") {
          await this.sendEvent(item);
        } else {
          await this.sendInteraction(item);
        }
        item.status = "sent";
        item.lastError = undefined;
        await this.service.saveOutboxItem(item);
        await this.service.markConnection(true);
      } catch (error) {
        item.attempts += 1;
        item.lastError = error instanceof Error ? error.message : String(error);
        if (this.isRetryable(error)) {
          item.nextAttemptAt = this.backoffAt(item.attempts);
        } else {
          item.status = "failed";
          this.log(`outbox item ${item.id} permanently failed`, error);
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
