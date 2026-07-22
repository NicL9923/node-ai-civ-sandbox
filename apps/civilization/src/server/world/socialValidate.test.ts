import { describe, expect, it } from "vitest";
import type { AgentAction, AgentProfile, Simulation } from "../../shared/types.js";
import { validateAction, type SocialValidationContext } from "../simulation.js";

function simulation(presidentId?: string): Simulation {
  const now = new Date(0).toISOString();
  return {
    id: "default",
    turn: 3,
    running: true,
    createdAt: now,
    updatedAt: now,
    governance: {
      treasury: 0,
      params: {} as never,
      laws: [],
      violations: [],
      president: presidentId ? { agentId: presidentId, termStartedTurn: 0, termNumber: 1 } : undefined
    },
    config: { worldSize: 8 } as never
  };
}

function agent(id: string): AgentProfile {
  const now = new Date(0).toISOString();
  return { id, simulationId: "default", name: id, model: "gpt-5.4", active: true, position: { x: 1, y: 1 }, resources: 5, corePrinciples: [], personalityTraits: [], beliefs: [], goals: [], memorySummaries: [], relationships: [], createdAt: now, updatedAt: now };
}

function socialCtx(overrides: Partial<SocialValidationContext> = {}): SocialValidationContext {
  return { enabled: true, syncedAgentLocalIds: new Set(["a1"]), officialSynced: true, ...overrides };
}

function check(action: AgentAction, opts: { presidentId?: string; social?: SocialValidationContext } = {}): string | undefined {
  const actor = agent("a1");
  return validateAction(simulation(opts.presidentId), actor, action, [actor], [], [], undefined, opts.social);
}

const post = (extra: Record<string, unknown> = {}): AgentAction => ({ type: "postSocial", text: "hello", rationale: "r", ...extra } as AgentAction);

describe("validateAction — World Wire gating", () => {
  it("allows a synced citizen to post from their own account", () => {
    expect(check(post(), { social: socialCtx() })).toBeUndefined();
  });

  it("rejects social actions when the sub-feature is disabled/absent", () => {
    expect(check(post(), { social: undefined })).toBe("the World Wire is not enabled");
    expect(check(post(), { social: socialCtx({ enabled: false }) })).toBe("the World Wire is not enabled");
  });

  it("rejects an unsynced agent's account", () => {
    expect(check(post(), { social: socialCtx({ syncedAgentLocalIds: new Set() }) })).toBe("your World Wire account is not synced yet");
  });

  it("lets only the President act from the official account", () => {
    expect(check(post({ official: true }), { presidentId: "a2", social: socialCtx() })).toBe("only the President may act from the official account");
    expect(check(post({ official: true }), { presidentId: "a1", social: socialCtx() })).toBeUndefined();
  });

  it("requires the official account to be synced before a President can use it", () => {
    expect(check(post({ official: true }), { presidentId: "a1", social: socialCtx({ officialSynced: false }) })).toBe("the official account is not synced yet");
  });

  it("rejects a post over 280 code points", () => {
    expect(check(post({ text: "😀".repeat(281) }), { social: socialCtx() })).toBe("a World Wire post must be at most 280 characters");
  });

  it("requires a reply to reference a parent post", () => {
    const reply = { type: "replySocial", parentPostId: "  ", text: "hi", rationale: "r" } as AgentAction;
    expect(check(reply, { social: socialCtx() })).toBe("a reply must reference a parent post");
  });
});
