// Server-only federation runtime types: durable store document shapes, the port the engine uses to
// talk to the federation subsystem, and convenient aliases for the P1 generated contract types.
// The contract types come straight from @ai-civ/federation-contracts — we never re-declare DTOs.
import type { components } from "@ai-civ/federation-contracts";
import type { ForeignAffairsSnapshot, KnownCivilization, SimulationEvent } from "../../shared/types.js";

export type CloudEvent = components["schemas"]["CloudEvent"];
export type Command = components["schemas"]["Command"];
export type InteractionRequest = components["schemas"]["InteractionRequest"];
export type AuthorityDecision = components["schemas"]["AuthorityDecision"];
export type PublicProjection = components["schemas"]["PublicProjection"];
export type ContactCommandData = components["schemas"]["ContactCommandData"];
export type MessageCommandData = components["schemas"]["MessageCommandData"];

/** Opaque forward-only command cursor (World `Cursor`). */
export type CommandCursor = string;

export type FederationDocKind = "state" | "outbox" | "inbox";

interface FederationDocBase {
  id: string;
  simulationId: string;
  kind: FederationDocKind;
}

/** Singleton connector + foreign-affairs state (id === FEDERATION_STATE_ID). */
export interface FederationStateDoc extends FederationDocBase {
  kind: "state";
  /** Provisioned/registered World civ id (mirrors config or registration result). */
  civId?: string;
  keyId?: string;
  displayName?: string;
  /** True once the civ has usable credentials (pre-provisioned or registered). */
  registered: boolean;
  registeredAt?: string;
  /** Forward-only cursor for the commands pull. Only advanced AFTER a command is acked. */
  commandCursor?: CommandCursor | null;
  lastHeartbeatAt?: string;
  lastPullAt?: string;
  /** True when the last successful World contact is recent. */
  connected: boolean;
  /** Cached citizen-safe directory of other civilizations, refreshed from listCivilizations/heartbeat. */
  knownCivs: KnownCivilization[];
  /** Compact ring buffer of recent foreign-affairs happenings, shown to every agent in the briefing. */
  recentWorldNotes: string[];
  updatedAt: string;
}

export type OutboxItemKind = "event" | "interaction";
export type OutboxStatus = "pending" | "sent" | "failed";

/** A durable outbound item (a CloudEvent export or a President-authorized interaction). */
export interface OutboxItemDoc extends FederationDocBase {
  kind: "outbox";
  itemKind: OutboxItemKind;
  /** Stable idempotency key sent to the World; identical across retries. */
  idempotencyKey: string;
  /** The exact payload to send (CloudEvent for events, InteractionRequest for interactions). */
  payload: CloudEvent | InteractionRequest;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt?: string;
  worldsequence?: string | null;
  /** World-assigned interaction id, recorded once the interaction is accepted. */
  interactionId?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export type InboxAckStatus = "applied" | "rejected" | "duplicate";

/** A dedupe record for a processed inbound command. id === `inbox_<dedupeKey>`. */
export interface InboxItemDoc extends FederationDocBase {
  kind: "inbox";
  dedupeKey: string;
  commandId: string;
  ackStatus: InboxAckStatus;
  detail?: string;
  createdAt: string;
}

export const FEDERATION_STATE_ID = "fed_state";

/** Input for a President-authorized cross-civ interaction, produced by the engine. */
export interface SubmitInteractionInput {
  idempotencyKey: string;
  kind: "contact" | "message";
  source: string;
  target: string;
  authorityDecision: AuthorityDecision;
  publicNarrative?: string;
  payload: components["schemas"]["ContactIntentData"] | components["schemas"]["MessageIntentData"];
}

/**
 * The narrow surface the simulation engine uses to talk to the federation subsystem. Every method is a
 * no-op-safe store operation — the engine never performs network I/O. When federation is disabled the
 * engine holds no port at all, so the standalone path is unchanged.
 */
export interface FederationPort {
  /** Enqueue an allowlisted local event as a CloudEvent export (best-effort; caller-gated by allowlist). */
  exportLocalEvent(event: SimulationEvent): Promise<void>;
  /** Durably enqueue a President interaction to the outbox (network send happens later in the connector). */
  submitInteraction(input: SubmitInteractionInput): Promise<void>;
  /** Cached citizen-safe foreign-affairs snapshot for prompts and the public world snapshot. */
  getSnapshot(): Promise<ForeignAffairsSnapshot>;
  /** Whether a civ id is currently in the cached directory (used to validate President targets). */
  isKnownCiv(civId: string): Promise<boolean>;
}
