// Type aliases over the generated federation contract. The World runtime and this UI share
// ONE source of truth (`@ai-civ/federation-contracts`); we never hand-duplicate DTOs.
import type { components } from "@ai-civ/federation-contracts";

type Schemas = components["schemas"];

export type Civilization = Schemas["PublicProjection"];
export type Leader = Schemas["Leader"];
export type EconomySummary = Schemas["EconomySummary"];
export type Capabilities = Schemas["Capabilities"];
export type CivilizationListPage = Schemas["CivilizationListPage"];

export type Relationship = Schemas["Relationship"];
export type RelationshipPage = Schemas["RelationshipPage"];
export type CivPair = Schemas["CivPair"];
/** Open set; known values allied|friendly|neutral|wary|hostile. Clients tolerate unknowns. */
export type RelationshipStance = Schemas["RelationshipStance"];

export type WorldEvent = Schemas["CloudEvent"];
export type EventPage = Schemas["EventPage"];

/**
 * Allowlisted, citizen-safe public `data` shape the World attaches to interaction events
 * (see PublicEventFactory). Civ-ingested events carry `data: null`. Every field is optional
 * and rendered as plain text only.
 */
export interface PublicEventData {
  kind?: "contact" | "message" | string;
  fromCiv?: string;
  fromDisplayName?: string;
  subject?: string;
  publicNarrative?: string;
}
