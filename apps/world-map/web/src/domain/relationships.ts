// Relationship visual encoding. Everything meaningful is carried by LINEWORK (pattern),
// WEIGHT (stroke width), and LABELS — never by color alone (see PRODUCT.md principle 3).
// The single signal-ink accent is reserved for genuine threat emphasis.
import type { Relationship, RelationshipStance } from "../api/types";

/** Metric ranges as defined by the World domain (Relationship.cs). */
export const TRUST_RANGE = [-1, 1] as const;
export const GRIEVANCE_RANGE = [0, 100] as const;
export const THREAT_RANGE = [0, 100] as const;
export const UNIT_RANGE = [0, 1] as const;

/** Server treats grievance/threat >= 50 as high (RelationshipMath). */
export const HIGH_THREAT = 50;
export const HIGH_GRIEVANCE = 50;

export type EdgePattern = "double" | "solid" | "hairline" | "dashed" | "barbed" | "dotted";

export interface EdgeTreatment {
  stance: string;
  /** True when stance is a known value; unknown open-set values still render (dotted). */
  known: boolean;
  pattern: EdgePattern;
  strokeWidth: number;
  /** "threat" → draw with the signal-ink accent; otherwise ink. */
  emphasis: "threat" | "none";
  /** Plain, non-color description for aria/legend/tooltips. */
  description: string;
}

const KNOWN: Record<string, { pattern: EdgePattern; blurb: string }> = {
  allied: { pattern: "double", blurb: "double line" },
  friendly: { pattern: "solid", blurb: "solid line" },
  neutral: { pattern: "hairline", blurb: "thin line" },
  wary: { pattern: "dashed", blurb: "dashed line" },
  hostile: { pattern: "barbed", blurb: "barbed line" },
};

/** Canonical unordered pair key (civA <= civB), matching the World's canonicalization. */
export function pairKey(a: string, b: string): string {
  return a <= b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

export function splitPairKey(key: string): [string, string] {
  const idx = key.indexOf("\u0000");
  return idx < 0 ? [key, key] : [key.slice(0, idx), key.slice(idx + 1)];
}

/** Trust [-1,1] → stroke width [1, 3.5]px. Heavier ink = more trust. */
export function trustWeight(trust: number): number {
  const t = Math.min(1, Math.max(-1, Number.isFinite(trust) ? trust : 0));
  return 1 + ((t + 1) / 2) * 2.5;
}

export function edgeTreatment(rel: Relationship): EdgeTreatment {
  const stance = (rel.stance ?? "neutral") as RelationshipStance & string;
  const known = Object.prototype.hasOwnProperty.call(KNOWN, stance);
  const spec = known ? KNOWN[stance] : { pattern: "dotted" as EdgePattern, blurb: "dotted line (unrecognized stance)" };
  const threat = typeof rel.threat === "number" ? rel.threat : 0;
  const emphasis: "threat" | "none" = threat >= HIGH_THREAT ? "threat" : "none";

  const description =
    `${known ? stance : `${stance} (unrecognized)`}, shown as a ${spec.blurb}` +
    (emphasis === "threat" ? ", highlighted for high threat" : "");

  return {
    stance,
    known,
    pattern: spec.pattern,
    strokeWidth: trustWeight(typeof rel.trust === "number" ? rel.trust : 0),
    emphasis,
    description,
  };
}

/** SVG dash array for a pattern (barbed/double are drawn structurally, not via dashes). */
export function dashArray(pattern: EdgePattern): string | undefined {
  switch (pattern) {
    case "dashed":
      return "6 4";
    case "dotted":
      return "1 4";
    default:
      return undefined;
  }
}

export interface LegendEntry {
  stance: string;
  pattern: EdgePattern;
  label: string;
}

export const STANCE_LEGEND: LegendEntry[] = [
  { stance: "allied", pattern: "double", label: "Allied" },
  { stance: "friendly", pattern: "solid", label: "Friendly" },
  { stance: "neutral", pattern: "hairline", label: "Neutral" },
  { stance: "wary", pattern: "dashed", label: "Wary" },
  { stance: "hostile", pattern: "barbed", label: "Hostile" },
];
