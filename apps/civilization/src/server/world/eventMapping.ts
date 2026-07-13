// Explicit allowlist mapping local simulation events to citizen-safe CloudEvents for the World event
// feed. ONLY independent local governance facts are exported — never contact/message (those are
// delivered as interactions, and the World's process manager emits the authoritative world event) and
// never private data (agent memory, prompts, model responses, admin config, secrets).
import type { SimulationEvent, SimulationEventType } from "../../shared/types.js";
import type { CloudEvent } from "./federationTypes.js";

/** SimulationEventType -> CloudEvents `type`. Anything not present here is never exported. */
const EVENT_TYPE_ALLOWLIST: Partial<Record<SimulationEventType, string>> = {
  presidentElected: "civ.governance.president_elected.v1",
  constitutionAmended: "civ.governance.constitution_amended.v1",
  lawEnacted: "civ.governance.law_enacted.v1",
  decreeIssued: "civ.governance.decree_issued.v1"
};

export function isExportableEvent(type: SimulationEventType): boolean {
  return type in EVENT_TYPE_ALLOWLIST;
}

/**
 * Project an allowlisted local event into a CloudEvent. Returns undefined for non-allowlisted types.
 * The `data` payload is built ONLY from explicitly whitelisted, citizen-safe fields — never the raw
 * event.payload (which may carry the full action, self-revision, or model identifiers).
 */
export function mapEventToCloudEvent(event: SimulationEvent, civId: string): CloudEvent | undefined {
  const type = EVENT_TYPE_ALLOWLIST[event.type];
  if (!type) {
    return undefined;
  }

  const data: Record<string, unknown> = {
    turn: event.turn,
    summary: event.message
  };
  if (event.agentId) {
    data.agentRef = event.agentId;
  }
  if (event.proposalId) {
    data.proposalRef = event.proposalId;
  }

  return {
    id: event.id,
    specversion: "1.0",
    type,
    source: `/civilizations/${civId}`,
    subject: event.agentId ?? event.proposalId ?? event.simulationId,
    time: event.createdAt,
    datacontenttype: "application/json",
    data,
    idempotencykey: event.id
  };
}
