import { z } from "zod";
import type { AgentAction } from "../shared/types.js";

const rationale = z.string().min(1).max(600);
const terrain = z.enum(["grass", "water", "stone", "farm", "forum", "forest"]);
const voteChoice = z.enum(["yes", "no", "abstain"]);
const revisionList = z.array(z.string().trim().min(1).max(160)).max(1);
const selfRevision = z.object({
  principlesToAdd: revisionList.optional(),
  principlesToRetire: revisionList.optional(),
  traitsToAdd: revisionList.optional(),
  traitsToRetire: revisionList.optional(),
  beliefsToAdd: revisionList.optional(),
  beliefsToRetire: revisionList.optional(),
  goalsToAdd: revisionList.optional(),
  goalsToRetire: revisionList.optional(),
  memoryToAdd: z.string().trim().min(1).max(800).optional(),
  rationale: z.string().trim().min(1).max(500).optional()
}).optional();

const governanceParamKey = z.enum([
  "presidentTermTurns",
  "presidentCanTax",
  "presidentCanSpend",
  "presidentCanFine",
  "presidentCanPardon",
  "presidentCanDecree",
  "taxCapPerAction",
  "fineMax",
  "proposalCost",
  "changeTileCost"
]);

const policyChange = z.object({
  param: governanceParamKey,
  value: z.union([z.number(), z.boolean()])
});

const lawSpec = z.object({
  lawType: z.enum(["prohibition", "mandate", "tax"]),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(600),
  forbiddenAction: z.string().trim().min(1).max(40).optional(),
  amount: z.number().int().min(0).max(50).optional()
});

export const agentActionSchema: z.ZodType<AgentAction> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("move"),
    dx: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
    dy: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
    rationale,
    selfRevision
  }),
  z.object({
    type: z.literal("converse"),
    targetAgentId: z.string().min(1),
    message: z.string().min(1).max(800),
    rationale,
    selfRevision
  }),
  z.object({
    type: z.literal("reflect"),
    memory: z.string().min(1).max(800),
    rationale,
    selfRevision
  }),
  z.object({
    type: z.literal("proposeAmendment"),
    title: z.string().min(1).max(120),
    proposedText: z.string().min(20).max(2000),
    changeType: z.enum(["add", "revise", "repeal"]).optional(),
    targetReference: z.string().trim().min(1).max(120).optional(),
    policyChange: policyChange.optional(),
    enactLaw: lawSpec.optional(),
    rationale,
    selfRevision
  }),
  z.object({
    type: z.literal("vote"),
    proposalId: z.string().min(1),
    choice: voteChoice,
    rationale,
    selfRevision
  }),
  z.object({
    type: z.literal("changeTile"),
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    terrain,
    label: z.string().min(1).max(80).optional(),
    rationale,
    selfRevision
  }),
  z.object({
    type: z.literal("gather"),
    rationale,
    selfRevision
  }),
  z.object({
    type: z.literal("transfer"),
    targetAgentId: z.string().min(1),
    amount: z.number().int().min(1).max(1000),
    rationale,
    selfRevision
  }),
  z.object({
    type: z.literal("runForOffice"),
    platform: z.string().trim().min(1).max(400),
    rationale,
    selfRevision
  }),
  z.object({
    type: z.literal("voteForPresident"),
    candidateAgentId: z.string().min(1),
    rationale,
    selfRevision
  }),
  z.object({
    type: z.literal("tax"),
    amount: z.number().int().min(1).max(1000),
    rationale,
    selfRevision
  }),
  z.object({
    type: z.literal("spend"),
    targetAgentId: z.string().min(1).optional(),
    x: z.number().int().min(0).optional(),
    y: z.number().int().min(0).optional(),
    amount: z.number().int().min(1).max(1000),
    rationale,
    selfRevision
  }),
  z.object({
    type: z.literal("fine"),
    targetAgentId: z.string().min(1),
    amount: z.number().int().min(1).max(1000),
    reason: z.string().trim().min(1).max(400),
    violationId: z.string().min(1).optional(),
    rationale,
    selfRevision
  }),
  z.object({
    type: z.literal("pardon"),
    violationId: z.string().min(1),
    rationale,
    selfRevision
  }),
  z.object({
    type: z.literal("decree"),
    law: lawSpec,
    rationale,
    selfRevision
  }),
  z.object({
    type: z.literal("contactCivilization"),
    targetCivId: z.string().trim().min(1).max(120),
    greeting: z.string().trim().min(1).max(800),
    purpose: z.string().trim().min(1).max(400).optional(),
    rationale,
    selfRevision
  }),
  z.object({
    type: z.literal("messageCivilization"),
    targetCivId: z.string().trim().min(1).max(120),
    body: z.string().trim().min(1).max(1200),
    subject: z.string().trim().min(1).max(200).optional(),
    inReplyTo: z.string().trim().min(1).max(120).optional(),
    rationale,
    selfRevision
  }),
  z.object({
    type: z.literal("noop"),
    rationale,
    selfRevision
  })
]);

export function parseAgentAction(value: unknown): AgentAction {
  return agentActionSchema.parse(value);
}
