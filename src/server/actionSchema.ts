import { z } from "zod";
import type { AgentAction } from "../shared/types.js";

const rationale = z.string().min(1).max(600);
const terrain = z.enum(["grass", "water", "stone", "farm", "forum", "forest"]);
const voteChoice = z.enum(["yes", "no", "abstain"]);

export const agentActionSchema: z.ZodType<AgentAction> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("move"),
    dx: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
    dy: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
    rationale
  }),
  z.object({
    type: z.literal("converse"),
    targetAgentId: z.string().min(1),
    message: z.string().min(1).max(800),
    rationale
  }),
  z.object({
    type: z.literal("reflect"),
    memory: z.string().min(1).max(800),
    rationale
  }),
  z.object({
    type: z.literal("proposeAmendment"),
    title: z.string().min(1).max(120),
    proposedText: z.string().min(20).max(2000),
    rationale
  }),
  z.object({
    type: z.literal("vote"),
    proposalId: z.string().min(1),
    choice: voteChoice,
    rationale
  }),
  z.object({
    type: z.literal("changeTile"),
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    terrain,
    label: z.string().min(1).max(80).optional(),
    rationale
  }),
  z.object({
    type: z.literal("noop"),
    rationale
  })
]);

export function parseAgentAction(value: unknown): AgentAction {
  return agentActionSchema.parse(value);
}
