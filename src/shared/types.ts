export type ModelKey = string;

export type Terrain = "grass" | "water" | "stone" | "farm" | "forum" | "forest";

export interface Position {
  x: number;
  y: number;
}

export interface SimulationConfig {
  worldSize: number;
  actorsPerTurn: number;
  turnIntervalMs: number;
  proposalVotingWindowTurns: number;
  quorumRatio: number;
  supermajorityRatio: number;
  maxConsecutiveConverses: number;
  conversationSilenceThreshold: number;
  // Economy (operator knobs, env-synced).
  startResources: number;
  upkeepPerAction: number;
  gatherYield: number;
  gatherBase: number;
  tileMaxProductivity: number;
  tileRegenInterval: number;
  electionWindowTurns: number;
}

/**
 * Law-changeable governance levers ("constitutional control surface"). These live on
 * Simulation.governance (NOT SimulationConfig) so that changes enacted by passed laws
 * survive app restarts — ensureSeeded only re-syncs simulation.config from env.
 */
export interface GovernanceParams {
  presidentTermTurns: number;
  presidentCanTax: boolean;
  presidentCanSpend: boolean;
  presidentCanFine: boolean;
  presidentCanPardon: boolean;
  presidentCanDecree: boolean;
  taxCapPerAction: number;
  fineMax: number;
  proposalCost: number;
  changeTileCost: number;
}

export type GovernanceParamKey = keyof GovernanceParams;

export type LawType = "prohibition" | "mandate" | "tax";

export interface Law {
  id: string;
  type: LawType;
  title: string;
  description: string;
  forbiddenAction?: string;
  amount?: number;
  source: "amendment" | "decree";
  sourceRef?: string;
  enactedByAgentId?: string;
  createdTurn: number;
  active: boolean;
}

export interface Violation {
  id: string;
  agentId: string;
  lawId: string;
  lawTitle: string;
  turn: number;
  status: "pending" | "fined" | "pardoned";
  resolvedTurn?: number;
  resolvedByAgentId?: string;
  fineAmount?: number;
}

export interface PresidentTerm {
  agentId: string;
  termStartedTurn: number;
  termNumber: number;
  platform?: string;
}

export interface ElectionBallot {
  voterId: string;
  candidateId: string;
  turn: number;
}

export interface ElectionCandidate {
  agentId: string;
  platform: string;
  declaredTurn: number;
}

export interface Election {
  id: string;
  openedTurn: number;
  closesTurn: number;
  candidates: ElectionCandidate[];
  ballots: ElectionBallot[];
  status: "open" | "closed";
  winnerAgentId?: string;
}

export interface PolicyChange {
  param: GovernanceParamKey;
  value: number | boolean;
}

export interface Governance {
  treasury: number;
  params: GovernanceParams;
  president?: PresidentTerm;
  election?: Election;
  laws: Law[];
  violations: Violation[];
}

export interface Simulation {
  id: string;
  turn: number;
  running: boolean;
  config: SimulationConfig;
  governance: Governance;
  lastConversationTurn?: number;
  createdAt: string;
  updatedAt: string;
}

export interface Tile {
  id: string;
  simulationId: string;
  position: Position;
  terrain: Terrain;
  label?: string;
  productivity?: number;
  maxProductivity?: number;
  changedByAgentId?: string;
  changedAtTurn?: number;
}

export interface AgentRelationship {
  agentId: string;
  affinity: number;
  trust: number;
  notes: string[];
}

export interface AgentProfile {
  id: string;
  simulationId: string;
  name: string;
  model: ModelKey;
  active: boolean;
  position: Position;
  resources: number;
  corePrinciples: string[];
  personalityTraits: string[];
  beliefs: string[];
  goals: string[];
  memorySummaries: string[];
  voice?: string;
  relationships: AgentRelationship[];
  lastActedTurn?: number;
  lastConversedWith?: string;
  consecutiveConverses?: number;
  lastActionType?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConstitutionVersion {
  id: string;
  simulationId: string;
  version: number;
  text: string;
  amendmentProposalId?: string;
  createdAtTurn: number;
  createdAt: string;
}

export type VoteChoice = "yes" | "no" | "abstain";

export interface Vote {
  agentId: string;
  choice: VoteChoice;
  rationale: string;
  turn: number;
}

export type AmendmentChangeType = "add" | "revise" | "repeal";

export interface AmendmentProposal {
  id: string;
  simulationId: string;
  title: string;
  proposedText: string;
  rationale: string;
  proposerAgentId: string;
  status: "open" | "passed" | "failed";
  changeType?: AmendmentChangeType;
  targetReference?: string;
  policyChange?: PolicyChange;
  enactLaw?: LawSpecInput;
  openedTurn: number;
  closesTurn: number;
  votes: Vote[];
  createdAt: string;
  resolvedAt?: string;
}

export interface ProfileRevision {
  principlesToAdd?: string[];
  principlesToRetire?: string[];
  traitsToAdd?: string[];
  traitsToRetire?: string[];
  beliefsToAdd?: string[];
  beliefsToRetire?: string[];
  goalsToAdd?: string[];
  goalsToRetire?: string[];
  memoryToAdd?: string;
  rationale?: string;
}

interface AgentSelfRevision {
  selfRevision?: ProfileRevision;
}

/** Structured law a legislature (amendment) or executive (decree) can enact. */
export interface LawSpecInput {
  lawType: LawType;
  title: string;
  description: string;
  forbiddenAction?: string;
  amount?: number;
}

export type AgentAction =
  AgentSelfRevision & (
    | { type: "move"; dx: -1 | 0 | 1; dy: -1 | 0 | 1; rationale: string }
    | { type: "converse"; targetAgentId: string; message: string; rationale: string }
    | { type: "reflect"; memory: string; rationale: string }
    | {
        type: "proposeAmendment";
        title: string;
        proposedText: string;
        rationale: string;
        changeType?: AmendmentChangeType;
        targetReference?: string;
        policyChange?: PolicyChange;
        enactLaw?: LawSpecInput;
      }
    | { type: "vote"; proposalId: string; choice: VoteChoice; rationale: string }
    | { type: "changeTile"; x: number; y: number; terrain: Terrain; label?: string; rationale: string }
    | { type: "gather"; rationale: string }
    | { type: "transfer"; targetAgentId: string; amount: number; rationale: string }
    | { type: "runForOffice"; platform: string; rationale: string }
    | { type: "voteForPresident"; candidateAgentId: string; rationale: string }
    | { type: "tax"; amount: number; rationale: string }
    | { type: "spend"; targetAgentId?: string; x?: number; y?: number; amount: number; rationale: string }
    | { type: "fine"; targetAgentId: string; amount: number; reason: string; violationId?: string; rationale: string }
    | { type: "pardon"; violationId: string; rationale: string }
    | { type: "decree"; law: LawSpecInput; rationale: string }
    | { type: "noop"; rationale: string }
  );

export type SimulationEventType =
  | "simulationSeeded"
  | "turnAdvanced"
  | "agentActed"
  | "actionRejected"
  | "agentUpdated"
  | "proposalOpened"
  | "voteCast"
  | "constitutionAmended"
  | "proposalFailed"
  | "tileChanged"
  | "conversation"
  | "resourcesGathered"
  | "resourcesTransferred"
  | "electionOpened"
  | "candidacyDeclared"
  | "ballotCast"
  | "presidentElected"
  | "taxCollected"
  | "treasurySpent"
  | "lawEnacted"
  | "decreeIssued"
  | "violationRecorded"
  | "fineIssued"
  | "pardonIssued"
  | "policyChanged";

export interface SimulationEvent {
  id: string;
  simulationId: string;
  turn: number;
  type: SimulationEventType;
  message: string;
  agentId?: string;
  targetAgentId?: string;
  proposalId?: string;
  payload?: Record<string, unknown>;
  createdAt: string;
}

export interface WorldSnapshot {
  simulation: Simulation;
  tiles: Tile[];
  agents: AgentProfile[];
  currentConstitution: ConstitutionVersion;
  constitutionHistory: ConstitutionVersion[];
  proposals: AmendmentProposal[];
  recentEvents: SimulationEvent[];
}
