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
import {
  FEDERATION_STATE_ID,
  type Command,
  type ContactCommandData,
  type FederationPort,
  type FederationStateDoc,
  type InboxAckStatus,
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
  constructor(
    private readonly store: SimulationStore,
    private readonly config: FederationConfig,
    private readonly eventBus: EventBus,
    private readonly simulationId: string
  ) {}

  // --- state lifecycle -------------------------------------------------------

  async ensureState(): Promise<FederationStateDoc> {
    const existing = await this.store.getFederationState(this.simulationId);
    if (existing) {
      return existing;
    }
    const hasCreds = Boolean(this.config.civId && this.config.keyId && this.config.hmacSecret);
    const state: FederationStateDoc = {
      id: FEDERATION_STATE_ID,
      simulationId: this.simulationId,
      kind: "state",
      civId: this.config.civId,
      keyId: this.config.keyId,
      displayName: this.config.displayName,
      registered: hasCreds,
      registeredAt: hasCreds ? nowIso() : undefined,
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
    const id = `outbox_evt_${event.id}`;
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
    const id = `outbox_int_${input.idempotencyKey}`;
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
   * Apply an inbound command idempotently. Records a citizen-visible local event (with a deterministic
   * id so re-application upserts rather than duplicates), updates the compact briefing/directory, and
   * writes a dedupe record. Does NOT ack or advance the cursor — the connector does that AFTER acking.
   */
  async applyInboundCommand(command: Command): Promise<AckDecision> {
    const dedupeKey = this.dedupeKeyFor(command);
    const seen = await this.store.getInboxItem(this.simulationId, dedupeKey);
    if (seen) {
      return { status: "duplicate", detail: "Command already processed." };
    }

    const decision = await this.processCommand(command, dedupeKey);

    await this.store.putInboxItem({
      id: `inbox_${dedupeKey}`,
      simulationId: this.simulationId,
      kind: "inbox",
      dedupeKey,
      commandId: command.commandid,
      ackStatus: decision.status,
      detail: decision.detail,
      createdAt: nowIso()
    });
    return decision;
  }

  private async processCommand(command: Command, dedupeKey: string): Promise<AckDecision> {
    const type = command.type;
    if (type.startsWith("world.civilization.contact")) {
      const data = command.data as ContactCommandData | undefined;
      if (!data || typeof data.fromCiv !== "string") {
        return { status: "rejected", detail: "invalid_contact_payload" };
      }
      await this.upsertKnownCiv(data.fromCiv, data.fromDisplayName);
      const from = data.fromDisplayName ?? data.fromCiv;
      await this.recordForeignEvent("foreignContactReceived", `${from} reached out to us: ${data.greeting ?? "(greeting)"}`, dedupeKey, data.fromCiv);
      await this.addWorldNote(`${from} opened contact with us.`);
      return { status: "applied" };
    }
    if (type.startsWith("world.civilization.message")) {
      const data = command.data as MessageCommandData | undefined;
      if (!data || typeof data.fromCiv !== "string" || typeof data.body !== "string") {
        return { status: "rejected", detail: "invalid_message_payload" };
      }
      await this.upsertKnownCiv(data.fromCiv, data.fromDisplayName);
      const from = data.fromDisplayName ?? data.fromCiv;
      await this.recordForeignEvent("foreignMessageReceived", `${from} sent a message${data.subject ? ` (${data.subject})` : ""}: ${data.body}`, dedupeKey, data.fromCiv);
      await this.addWorldNote(`${from} sent us a message.`);
      return { status: "applied" };
    }
    // Unknown command types must never crash or stall the cursor: reject with a stable reason.
    return { status: "rejected", detail: "unsupported_command_type" };
  }

  /** Refresh the cached civ directory from public projections (self is excluded). */
  async refreshDirectory(projections: PublicProjection[]): Promise<void> {
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
  }

  async markConnection(connected: boolean, at?: string): Promise<void> {
    const state = await this.getState();
    if (connected) {
      state.lastHeartbeatAt = at ?? nowIso();
    }
    state.connected = connected;
    await this.saveState(state);
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
    const state = await this.getState();
    state.recentWorldNotes = [...state.recentWorldNotes, note].slice(-MAX_WORLD_NOTES);
    await this.saveState(state);
  }

  private async upsertKnownCiv(civId: string, displayName?: string): Promise<void> {
    const state = await this.getState();
    const existing: KnownCivilization | undefined = state.knownCivs.find((civ) => civ.civId === civId);
    if (existing) {
      if (displayName) {
        existing.displayName = displayName;
      }
    } else {
      state.knownCivs = [...state.knownCivs, { civId, displayName: displayName ?? civId }];
    }
    await this.saveState(state);
  }

  private async recordForeignEvent(
    type: SimulationEventType,
    message: string,
    dedupeKey: string,
    targetCivId?: string
  ): Promise<void> {
    const simulation = await this.store.getSimulation(this.simulationId);
    const event: SimulationEvent = {
      id: `event_fed_${dedupeKey}`,
      simulationId: this.simulationId,
      turn: simulation?.turn ?? 0,
      type,
      message,
      payload: targetCivId ? { targetCivId } : undefined,
      createdAt: nowIso()
    };
    await this.store.appendEvent(event);
    this.eventBus.publish(event);
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
