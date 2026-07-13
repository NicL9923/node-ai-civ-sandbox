import type { Civilization, Relationship, WorldEvent } from "../api/types";

/** Deterministic sample data for tests. */

export function makeCiv(overrides: Partial<Civilization> = {}): Civilization {
  return {
    civId: "civ_alpha",
    displayName: "Alpha",
    protocolVersion: "1.0.0",
    turn: 12,
    running: true,
    population: 1_250_000,
    president: { ref: "leader_1", name: "Ada Vane", title: "President", termNumber: 2 },
    economy: { treasury: 48_000, currency: "credits" },
    updatedAt: "2026-07-13T12:00:00Z",
    ...overrides,
  };
}

export function makeRelationship(overrides: Partial<Relationship> = {}): Relationship {
  return {
    pair: { civA: "civ_alpha", civB: "civ_beta" },
    trust: 0.4,
    grievance: 10,
    threat: 5,
    familiarity: 0.3,
    interdependence: 0.2,
    stance: "friendly",
    narrativeSummary: "Cordial trade relations.",
    version: 3,
    updatedAt: "2026-07-13T11:59:00Z",
    ...overrides,
  };
}

export function makeEvent(overrides: Partial<WorldEvent> = {}): WorldEvent {
  return {
    id: "evt_1",
    specversion: "1.0",
    type: "world.civilization.message.v1",
    source: "civ_alpha",
    subject: "civ_beta",
    time: "2026-07-13T12:00:00Z",
    datacontenttype: "application/json",
    worldsequence: "1",
    data: {
      kind: "message",
      fromCiv: "civ_alpha",
      fromDisplayName: "Alpha",
      subject: "Trade terms",
      publicNarrative: "Alpha proposed new trade terms to Beta.",
    },
    ...overrides,
  };
}
