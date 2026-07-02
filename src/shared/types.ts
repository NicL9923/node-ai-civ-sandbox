export type ModelKey = "gpt-5.5" | "claude-sonnet-5";

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
}

export interface Simulation {
  id: string;
  turn: number;
  running: boolean;
  config: SimulationConfig;
  createdAt: string;
  updatedAt: string;
}

export interface Tile {
  id: string;
  simulationId: string;
  position: Position;
  terrain: Terrain;
  label?: string;
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
  corePrinciples: string[];
  personalityTraits: string[];
  beliefs: string[];
  goals: string[];
  memorySummaries: string[];
  relationships: AgentRelationship[];
  lastActedTurn?: number;
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

export interface AmendmentProposal {
  id: string;
  simulationId: string;
  title: string;
  proposedText: string;
  rationale: string;
  proposerAgentId: string;
  status: "open" | "passed" | "failed";
  openedTurn: number;
  closesTurn: number;
  votes: Vote[];
  createdAt: string;
  resolvedAt?: string;
}

export type AgentAction =
  | { type: "move"; dx: -1 | 0 | 1; dy: -1 | 0 | 1; rationale: string }
  | { type: "converse"; targetAgentId: string; message: string; rationale: string }
  | { type: "reflect"; memory: string; rationale: string }
  | { type: "proposeAmendment"; title: string; proposedText: string; rationale: string }
  | { type: "vote"; proposalId: string; choice: VoteChoice; rationale: string }
  | { type: "changeTile"; x: number; y: number; terrain: Terrain; label?: string; rationale: string }
  | { type: "noop"; rationale: string };

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
  | "conversation";

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
