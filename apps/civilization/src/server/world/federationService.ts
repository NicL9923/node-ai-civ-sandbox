// Store-backed federation core. Implements the engine-facing FederationPort (enqueue exports/interactions,
// snapshot, directory lookups) and the connector-facing operations (outbox lifecycle, inbound command
// application with idempotent effects, cursor + directory + connection state). It performs NO network
// I/O — the connector owns all World calls. Every effect is idempotent so at-least-once delivery yields
// exactly-once observable results (see plan.md for the failure-window analysis).
import type { ForeignAffairsSnapshot, KnownCivilization, SimulationEvent, SimulationEventType } from "../../shared/types.js";
import type { FederationConfig } from "../config.js";
import type { EventBus } from "../eventBus.js";
import { newId, nowIso } from "../id.js";
import type { SimulationStore } from "../store.js";
import { isExportableEvent, mapEventToCloudEvent } from "./eventMapping.js";
import { safeFederationId } from "./federationIds.js";
import {
  FEDERATION_STATE_ID,
  type Command,
  type ContactCommandData,
  type FederationPort,
  type FederationStateDoc,
  type InboxAckStatus,
  type InboxItemDoc,
  type InteractionRequest,
  type MessageCommandData,
  type OutboxItemDoc,
  type PublicProjection,
  type SubmitInteractionInput
} from "./federationTypes.js";

const MAX_WORLD_NOTES = 5;
/** Older than this since the last successful World contact ⇒ we report `connected: false` (stale). */
const CONNECTION_STALENESS_MS = 2 * 60 * 1000;

export interface AckDecision {
  status: InboxAckStatus;
  detail?: string;
}

export class FederationService implements FederationPort {
  // Serializes every read-modify-write of the singleton federation state doc. The connector's
  // heartbeat / poll / flush loops run on independent timers and can overlap; without this, two
  // concurrent whole-document writes would last-writer-wins clobber each other (e.g. a heartbeat's
  // markConnection could erase a just-committed inbound world note). All state mutators funnel through
  // runExclusive so the atomic-inbox guarantee holds under concurrency.
  private stateLock: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: SimulationStore,
    private readonly config: FederationConfig,
    private readonly eventBus: EventBus,
    private readonly simulationId: string
  ) {}

  // --- state lifecycle -------------------------------------------------------

  /**
   * Load or create the federation state, reconciling the persisted assigned identity against any
   * EXPLICITLY configured identity (WORLD_CIV_ID / WORLD_KEY_ID). The env is always authoritative:
   * persisted state must never silently override explicit config.
   *
   * - Registration mode (no explicit civId/keyId): use the persisted assigned identity if present,
   *   otherwise start unregistered and let the onboarding flow assign one.
   * - Explicit mode, same civId, changed keyId: adopt the explicit keyId (key rotation), preserving the
   *   cursor / outbox / inbox.
   * - Explicit mode, DIFFERENT civId than persisted: FAIL CLOSED with a clear (secret-free) error rather
   *   than send a wrong identity or mix another civ's outbox/inbox.
   */
  async ensureState(): Promise<FederationStateDoc> {
    const existing = await this.store.getFederationState(this.simulationId);
    const explicitCivId = this.config.civId;
    const explicitKeyId = this.config.keyId;
    const explicitMode = Boolean(explicitCivId && explicitKeyId);

    if (existing) {
      if (explicitMode) {
        if (existing.civId && existing.civId !== explicitCivId) {
          throw new Error(
            `Federation identity mismatch: this simulation is persisted as civ '${existing.civId}' but WORLD_CIV_ID is '${explicitCivId}'. ` +
              "Changing a simulation's federation identity requires a fresh SIMULATION_ID (or an explicit future reset/migration); refusing to operate."
          );
        }
        // Same civ (or persisted had none yet): adopt the explicit identity, incl. key rotation.
        if (existing.civId !== explicitCivId || existing.keyId !== explicitKeyId) {
          existing.civId = explicitCivId;
          existing.keyId = explicitKeyId;
          existing.registered = true;
          existing.registeredAt = existing.registeredAt ?? nowIso();
          await this.saveState(existing);
        }
      }
      return existing;
    }

    const state: FederationStateDoc = {
      id: FEDERATION_STATE_ID,
      simulationId: this.simulationId,
      kind: "state",
      civId: explicitMode ? explicitCivId : undefined,
      keyId: explicitMode ? explicitKeyId : undefined,
      displayName: this.config.displayName,
      registered: explicitMode,
      registeredAt: explicitMode ? nowIso() : undefined,
      commandCursor: null,
      connected: false,
      knownCivs: [],
      recentWorldNotes: [],
      updatedAt: nowIso()
    };
    await this.store.putFederationState(state);
    return state;
  }

  async getState(): Promise<FederationStateDoc> {
    return this.ensureState();
  }

  async saveState(state: FederationStateDoc): Promise<void> {
    state.updatedAt = nowIso();
    await this.store.putFederationState(state);
  }

  /**
   * Run a state read-modify-write exclusively, serialized against all other such operations. Callers
   * must NOT invoke another runExclusive-wrapped method from within `fn` (no re-entrancy).
   */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.stateLock.then(fn, fn);
    // Keep the chain alive regardless of outcome, and swallow settlement to avoid unhandled rejections.
    this.stateLock = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  // --- FederationPort (engine-facing) ---------------------------------------

  async exportLocalEvent(event: SimulationEvent): Promise<void> {
    if (!isExportableEvent(event.type)) {
      return;
    }
    const state = await this.getState();
    if (!state.civId) {
      // No civ id yet (registration pending): the event feed requires an authenticated identity.
      return;
    }
    const cloudEvent = mapEventToCloudEvent(event, state.civId);
    if (!cloudEvent) {
      return;
    }
    const id = safeFederationId("outbox_evt", event.id);
    const existing = (await this.store.listOutbox(this.simulationId)).find((item) => item.id === id);
    if (existing) {
      return;
    }
    const now = nowIso();
    const item: OutboxItemDoc = {
      id,
      simulationId: this.simulationId,
      kind: "outbox",
      itemKind: "event",
      idempotencyKey: cloudEvent.idempotencykey ?? event.id,
      payload: cloudEvent,
      status: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now
    };
    await this.store.putOutboxItem(item);
  }

  async submitInteraction(input: SubmitInteractionInput): Promise<void> {
    const id = safeFederationId("outbox_int", input.idempotencyKey);
    const existing = (await this.store.listOutbox(this.simulationId)).find((item) => item.id === id);
    if (existing) {
      return;
    }
    const request: InteractionRequest = {
      kind: input.kind,
      source: input.source,
      target: input.target,
      authorityDecision: input.authorityDecision,
      publicNarrative: input.publicNarrative,
      payload: input.payload
    };
    const now = nowIso();
    const item: OutboxItemDoc = {
      id,
      simulationId: this.simulationId,
      kind: "outbox",
      itemKind: "interaction",
      idempotencyKey: input.idempotencyKey,
      payload: request,
      status: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now
    };
    await this.store.putOutboxItem(item);

    const targetName = (await this.getState()).knownCivs.find((civ) => civ.civId === input.target)?.displayName ?? input.target;
    await this.addWorldNote(
      input.kind === "contact"
        ? `Our President opened contact with ${targetName}.`
        : `Our President sent a message to ${targetName}.`
    );
  }

  async getSnapshot(): Promise<ForeignAffairsSnapshot> {
    const state = await this.getState();
    const outbox = await this.store.listOutbox(this.simulationId);
    const connected = this.isConnected(state);
    return {
      enabled: true,
      registered: state.registered,
      connected,
      civId: state.civId,
      displayName: state.displayName,
      lastHeartbeatAt: state.lastHeartbeatAt,
      briefing: this.buildBriefing(state, connected),
      knownCivilizations: state.knownCivs,
      pendingOutbox: outbox.filter((item) => item.status === "pending").length,
      failedOutbox: outbox.filter((item) => item.status === "failed").length
    };
  }

  async isKnownCiv(civId: string): Promise<boolean> {
    const state = await this.getState();
    return state.knownCivs.some((civ) => civ.civId === civId);
  }

  // --- connector-facing ------------------------------------------------------

  async listPendingOutbox(): Promise<OutboxItemDoc[]> {
    return this.store.listOutbox(this.simulationId, ["pending"]);
  }

  async saveOutboxItem(item: OutboxItemDoc): Promise<void> {
    item.updatedAt = nowIso();
    await this.store.putOutboxItem(item);
  }

  /**
   * Apply an inbound command idempotently. Records a citizen-visible local event (with a deterministic,
   * Cosmos-safe id so re-application upserts rather than duplicates), and atomically commits the
   * foreign-affairs state change (known-civ + briefing note) together with the terminal inbox dedupe
   * record in ONE transactional batch. Does NOT ack or advance the cursor — the connector does that
   * AFTER acking. Because the briefing mutation and the dedupe record commit together, a crash/replay
   * can never append the same world note twice.
   */
  async applyInboundCommand(command: Command): Promise<AckDecision> {
    const rawKey = this.dedupeKeyFor(command);
    const inboxId = safeFederationId("inbox", rawKey);
    const seen = await this.store.getInboxItem(this.simulationId, inboxId);
    if (seen) {
      return { status: "duplicate", detail: "Command already processed." };
    }

    const simulation = await this.store.getSimulation(this.simulationId);
    const turn = simulation?.turn ?? 0;

    return this.runExclusive(async () => {
      // Re-check dedupe inside the lock: a concurrent apply of the same command may have committed
      // while we awaited the lock.
      const already = await this.store.getInboxItem(this.simulationId, inboxId);
      if (already) {
        return { status: "duplicate", detail: "Command already processed." };
      }
      // Work on a clone so nothing is persisted until the atomic batch below (in the memory store,
      // getState() returns the live object by reference, so mutating it directly would leak state).
      const state = structuredClone(await this.getState());
      const outcome = this.evaluateCommand(command, rawKey, turn, state);

      // The deterministic local event is upsert-keyed by a safe id, so writing it before the terminal
      // batch is replay-safe: a retry rewrites the identical document rather than adding a duplicate.
      if (outcome.event) {
        await this.store.appendEvent(outcome.event);
        this.eventBus.publish(outcome.event);
      }

      const inbox: InboxItemDoc = {
        id: inboxId,
        simulationId: this.simulationId,
        kind: "inbox",
        dedupeKey: rawKey,
        commandId: command.commandid,
        ackStatus: outcome.decision.status,
        detail: outcome.decision.detail,
        createdAt: nowIso()
      };
      state.updatedAt = nowIso();
      await this.store.commitInboundCommand(state, inbox);
      return outcome.decision;
    });
  }

  /**
   * Pure evaluation of an inbound command: mutates the passed (cloned) state in memory and returns the
   * ack decision plus an optional deterministic local event. Performs NO persistence.
   */
  private evaluateCommand(
    command: Command,
    rawKey: string,
    turn: number,
    state: FederationStateDoc
  ): { decision: AckDecision; event?: SimulationEvent } {
    const type = command.type;
    if (type.startsWith("world.civilization.contact")) {
      const data = command.data as ContactCommandData | undefined;
      if (!data || typeof data.fromCiv !== "string") {
        return { decision: { status: "rejected", detail: "invalid_contact_payload" } };
      }
      mutateUpsertKnownCiv(state, data.fromCiv, data.fromDisplayName);
      const from = data.fromDisplayName ?? data.fromCiv;
      mutateAddWorldNote(state, `${from} opened contact with us.`);
      return {
        decision: { status: "applied" },
        event: this.buildForeignEvent("foreignContactReceived", `${from} reached out to us: ${data.greeting ?? "(greeting)"}`, rawKey, turn, data.fromCiv)
      };
    }
    if (type.startsWith("world.civilization.message")) {
      const data = command.data as MessageCommandData | undefined;
      if (!data || typeof data.fromCiv !== "string" || typeof data.body !== "string") {
        return { decision: { status: "rejected", detail: "invalid_message_payload" } };
      }
      mutateUpsertKnownCiv(state, data.fromCiv, data.fromDisplayName);
      const from = data.fromDisplayName ?? data.fromCiv;
      mutateAddWorldNote(state, `${from} sent us a message.`);
      return {
        decision: { status: "applied" },
        event: this.buildForeignEvent("foreignMessageReceived", `${from} sent a message${data.subject ? ` (${data.subject})` : ""}: ${data.body}`, rawKey, turn, data.fromCiv)
      };
    }
    // Unknown command types must never crash or stall the cursor: reject with a stable reason. State is
    // left untouched (no world note), but the inbox dedupe record is still written by the caller.
    return { decision: { status: "rejected", detail: "unsupported_command_type" } };
  }

  private buildForeignEvent(
    type: SimulationEventType,
    message: string,
    rawKey: string,
    turn: number,
    targetCivId?: string
  ): SimulationEvent {
    return {
      id: safeFederationId("event_fed", rawKey),
      simulationId: this.simulationId,
      turn,
      type,
      message,
      payload: targetCivId ? { targetCivId } : undefined,
      createdAt: nowIso()
    };
  }

  /**
   * Replace the cached civ directory from a COMPLETE, already-paginated set of public projections
   * (the connector owns pagination and only calls this after every page succeeds). Self is filtered
   * out. Entries previously learned via inbound contact/message that are not in the directory page set
   * are retained (union) so an active correspondent is never dropped.
   */
  async refreshDirectory(projections: PublicProjection[]): Promise<void> {
    await this.runExclusive(async () => {
      const state = await this.getState();
      const byId = new Map(state.knownCivs.map((civ) => [civ.civId, civ]));
      for (const projection of projections) {
        if (projection.civId === state.civId) {
          continue;
        }
        byId.set(projection.civId, {
          civId: projection.civId,
          displayName: projection.displayName,
          lastSeenTurn: projection.turn
        });
      }
      state.knownCivs = [...byId.values()];
      await this.saveState(state);
    });
  }

  /** Advance the persisted forward-only command cursor (serialized against other state writes). */
  async advanceCursor(cursor: string): Promise<void> {
    await this.runExclusive(async () => {
      const state = await this.getState();
      state.commandCursor = cursor;
      await this.saveState(state);
    });
  }

  async markConnection(connected: boolean, at?: string): Promise<void> {
    await this.runExclusive(async () => {
      const state = await this.getState();
      if (connected) {
        state.lastHeartbeatAt = at ?? nowIso();
      }
      state.connected = connected;
      await this.saveState(state);
    });
  }

  /** Build the citizen-safe public projection for register/heartbeat from local simulation state. */
  async buildProjection(): Promise<PublicProjection> {
    const state = await this.getState();
    const simulation = await this.store.getSimulation(this.simulationId);
    const agents = await this.store.listAgents(this.simulationId);
    const active = agents.filter((agent) => agent.active);
    const governance = simulation?.governance;
    const president = governance?.president;
    const presidentAgent = president ? active.find((agent) => agent.id === president.agentId) : undefined;
    return {
      civId: state.civId ?? this.simulationId,
      displayName: state.displayName ?? this.config.displayName,
      protocolVersion: `${this.config.protocolVersion}.0.0`,
      turn: simulation?.turn ?? 0,
      running: simulation?.running ?? false,
      population: active.length,
      president: president
        ? {
            // Opaque, citizen-safe reference — never the internal agent id.
            ref: `term-${president.termNumber}`,
            name: presidentAgent?.name ?? "President",
            title: "President",
            termNumber: president.termNumber
          }
        : null,
      economy: governance ? { treasury: governance.treasury, currency: "credits" } : null,
      lastProcessedWorldCursor: state.commandCursor ?? null,
      updatedAt: nowIso()
    };
  }

  // --- helpers ---------------------------------------------------------------

  private dedupeKeyFor(command: Command): string {
    if (command.idempotencykey) {
      return command.idempotencykey;
    }
    if (command.source && command.id) {
      return `${command.source}:${command.id}`;
    }
    return command.commandid;
  }

  private isConnected(state: FederationStateDoc): boolean {
    if (!state.lastHeartbeatAt) {
      return false;
    }
    return Date.now() - new Date(state.lastHeartbeatAt).getTime() < CONNECTION_STALENESS_MS;
  }

  private buildBriefing(state: FederationStateDoc, connected: boolean): string[] {
    const lines: string[] = [];
    if (!connected) {
      lines.push("The World is currently unreachable; foreign affairs are paused but local life continues.");
    } else if (state.knownCivs.length > 0) {
      lines.push(`Known civilizations: ${state.knownCivs.map((civ) => civ.displayName).join(", ")}.`);
    } else {
      lines.push("No other civilizations are known yet.");
    }
    lines.push(...state.recentWorldNotes.slice(-MAX_WORLD_NOTES));
    return lines;
  }

  private async addWorldNote(note: string): Promise<void> {
    await this.runExclusive(async () => {
      const state = await this.getState();
      mutateAddWorldNote(state, note);
      await this.saveState(state);
    });
  }

  /** Record a locally-originated foreign-affairs lifecycle event (President sent contact/message, ack, …). */
  async recordLocalForeignEvent(
    type: SimulationEventType,
    message: string,
    payload?: Record<string, unknown>
  ): Promise<void> {
    const simulation = await this.store.getSimulation(this.simulationId);
    const event: SimulationEvent = {
      id: newId("event"),
      simulationId: this.simulationId,
      turn: simulation?.turn ?? 0,
      type,
      message,
      payload,
      createdAt: nowIso()
    };
    await this.store.appendEvent(event);
    this.eventBus.publish(event);
  }
}

// --- pure state mutators (shared by the inbound atomic path and the local persist helpers) ---------

/** Append a compact world note to the ring buffer (in place). */
function mutateAddWorldNote(state: FederationStateDoc, note: string): void {
  state.recentWorldNotes = [...state.recentWorldNotes, note].slice(-MAX_WORLD_NOTES);
}

/** Insert or refresh a known civilization (in place). */
function mutateUpsertKnownCiv(state: FederationStateDoc, civId: string, displayName?: string): void {
  const existing: KnownCivilization | undefined = state.knownCivs.find((civ) => civ.civId === civId);
  if (existing) {
    if (displayName) {
      existing.displayName = displayName;
    }
  } else {
    state.knownCivs = [...state.knownCivs, { civId, displayName: displayName ?? civId }];
  }
}
