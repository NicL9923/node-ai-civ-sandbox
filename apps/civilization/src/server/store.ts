import { CosmosClient, type Container, type SqlQuerySpec } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import type {
  AgentProfile,
  AmendmentProposal,
  ConstitutionVersion,
  Simulation,
  SimulationEvent,
  Tile
} from "../shared/types.js";
import type { AppConfig } from "./config.js";
import {
  FEDERATION_STATE_ID,
  type FederationStateDoc,
  type InboxItemDoc,
  type OutboxItemDoc,
  type OutboxStatus
} from "./world/federationTypes.js";

export interface SimulationStore {
  getSimulation(id: string): Promise<Simulation | undefined>;
  upsertSimulation(simulation: Simulation): Promise<void>;
  deleteSimulationData(simulationId: string): Promise<void>;
  listTiles(simulationId: string): Promise<Tile[]>;
  upsertTiles(tiles: Tile[]): Promise<void>;
  listAgents(simulationId: string): Promise<AgentProfile[]>;
  upsertAgent(agent: AgentProfile): Promise<void>;
  listConstitutions(simulationId: string): Promise<ConstitutionVersion[]>;
  upsertConstitution(version: ConstitutionVersion): Promise<void>;
  listProposals(simulationId: string): Promise<AmendmentProposal[]>;
  upsertProposal(proposal: AmendmentProposal): Promise<void>;
  listRecentEvents(simulationId: string, limit: number): Promise<SimulationEvent[]>;
  appendEvent(event: SimulationEvent): Promise<void>;
  // Federation subsystem (all docs partitioned by simulationId). Only exercised when the connector runs.
  getFederationState(simulationId: string): Promise<FederationStateDoc | undefined>;
  putFederationState(state: FederationStateDoc): Promise<void>;
  listOutbox(simulationId: string, statuses?: OutboxStatus[]): Promise<OutboxItemDoc[]>;
  putOutboxItem(item: OutboxItemDoc): Promise<void>;
  getInboxItem(simulationId: string, dedupeKey: string): Promise<InboxItemDoc | undefined>;
  putInboxItem(item: InboxItemDoc): Promise<void>;
}

export class MemorySimulationStore implements SimulationStore {
  private simulations = new Map<string, Simulation>();
  private tiles = new Map<string, Tile>();
  private agents = new Map<string, AgentProfile>();
  private constitutions = new Map<string, ConstitutionVersion>();
  private proposals = new Map<string, AmendmentProposal>();
  private events = new Map<string, SimulationEvent>();
  private federationState = new Map<string, FederationStateDoc>();
  private outbox = new Map<string, OutboxItemDoc>();
  private inbox = new Map<string, InboxItemDoc>();

  async getSimulation(id: string): Promise<Simulation | undefined> {
    return this.simulations.get(id);
  }

  async upsertSimulation(simulation: Simulation): Promise<void> {
    this.simulations.set(simulation.id, simulation);
  }

  async deleteSimulationData(simulationId: string): Promise<void> {
    this.simulations.delete(simulationId);
    deleteWhere(this.tiles, (tile) => tile.simulationId === simulationId);
    deleteWhere(this.agents, (agent) => agent.simulationId === simulationId);
    deleteWhere(this.constitutions, (constitution) => constitution.simulationId === simulationId);
    deleteWhere(this.proposals, (proposal) => proposal.simulationId === simulationId);
    deleteWhere(this.events, (event) => event.simulationId === simulationId);
    this.federationState.delete(simulationId);
    deleteWhere(this.outbox, (item) => item.simulationId === simulationId);
    deleteWhere(this.inbox, (item) => item.simulationId === simulationId);
  }

  async listTiles(simulationId: string): Promise<Tile[]> {
    return [...this.tiles.values()].filter((tile) => tile.simulationId === simulationId);
  }

  async upsertTiles(tiles: Tile[]): Promise<void> {
    for (const tile of tiles) {
      this.tiles.set(tile.id, tile);
    }
  }

  async listAgents(simulationId: string): Promise<AgentProfile[]> {
    return [...this.agents.values()].filter((agent) => agent.simulationId === simulationId);
  }

  async upsertAgent(agent: AgentProfile): Promise<void> {
    this.agents.set(agent.id, agent);
  }

  async listConstitutions(simulationId: string): Promise<ConstitutionVersion[]> {
    return [...this.constitutions.values()]
      .filter((constitution) => constitution.simulationId === simulationId)
      .sort((a, b) => b.version - a.version);
  }

  async upsertConstitution(version: ConstitutionVersion): Promise<void> {
    this.constitutions.set(version.id, version);
  }

  async listProposals(simulationId: string): Promise<AmendmentProposal[]> {
    return [...this.proposals.values()]
      .filter((proposal) => proposal.simulationId === simulationId)
      .sort((a, b) => b.openedTurn - a.openedTurn);
  }

  async upsertProposal(proposal: AmendmentProposal): Promise<void> {
    this.proposals.set(proposal.id, proposal);
  }

  async listRecentEvents(simulationId: string, limit: number): Promise<SimulationEvent[]> {
    return [...this.events.values()]
      .filter((event) => event.simulationId === simulationId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async appendEvent(event: SimulationEvent): Promise<void> {
    this.events.set(event.id, event);
  }

  async getFederationState(simulationId: string): Promise<FederationStateDoc | undefined> {
    return this.federationState.get(simulationId);
  }

  async putFederationState(state: FederationStateDoc): Promise<void> {
    this.federationState.set(state.simulationId, state);
  }

  async listOutbox(simulationId: string, statuses?: OutboxStatus[]): Promise<OutboxItemDoc[]> {
    const items = [...this.outbox.values()].filter((item) => item.simulationId === simulationId);
    const filtered = statuses ? items.filter((item) => statuses.includes(item.status)) : items;
    return filtered.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async putOutboxItem(item: OutboxItemDoc): Promise<void> {
    this.outbox.set(item.id, item);
  }

  async getInboxItem(simulationId: string, dedupeKey: string): Promise<InboxItemDoc | undefined> {
    const item = this.inbox.get(`${simulationId}:${dedupeKey}`);
    return item;
  }

  async putInboxItem(item: InboxItemDoc): Promise<void> {
    this.inbox.set(`${item.simulationId}:${item.dedupeKey}`, item);
  }
}

interface CosmosDocument {
  id: string;
  simulationId?: string;
}

class CosmosContainerStore<T extends CosmosDocument> {
  constructor(private readonly container: Container) {}

  async upsert(item: T): Promise<void> {
    await this.container.items.upsert(item);
  }

  async delete(id: string, partitionKey: string): Promise<void> {
    await this.container.item(id, partitionKey).delete();
  }

  async queryBySimulation(simulationId: string): Promise<T[]> {
    const { resources } = await this.container.items
      .query<T>({
        query: "SELECT * FROM c WHERE c.simulationId = @simulationId",
        parameters: [{ name: "@simulationId", value: simulationId }]
      })
      .fetchAll();
    return resources;
  }

  async query(querySpec: SqlQuerySpec): Promise<T[]> {
    const { resources } = await this.container.items.query<T>(querySpec).fetchAll();
    return resources;
  }

  async read(id: string, partitionKey: string): Promise<T | undefined> {
    try {
      const { resource } = await this.container.item(id, partitionKey).read<T>();
      return resource;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === 404) {
        return undefined;
      }
      throw error;
    }
  }
}

export class CosmosSimulationStore implements SimulationStore {
  private readonly simulations: CosmosContainerStore<Simulation>;
  private readonly tiles: CosmosContainerStore<Tile>;
  private readonly agents: CosmosContainerStore<AgentProfile>;
  private readonly constitutions: CosmosContainerStore<ConstitutionVersion>;
  private readonly proposals: CosmosContainerStore<AmendmentProposal>;
  private readonly events: CosmosContainerStore<SimulationEvent>;
  private readonly federation: CosmosContainerStore<FederationStateDoc | OutboxItemDoc | InboxItemDoc>;

  constructor(client: CosmosClient, databaseId: string) {
    const database = client.database(databaseId);
    this.simulations = new CosmosContainerStore<Simulation>(database.container("simulations"));
    this.tiles = new CosmosContainerStore<Tile>(database.container("tiles"));
    this.agents = new CosmosContainerStore<AgentProfile>(database.container("agents"));
    this.constitutions = new CosmosContainerStore<ConstitutionVersion>(database.container("constitutions"));
    this.proposals = new CosmosContainerStore<AmendmentProposal>(database.container("proposals"));
    this.events = new CosmosContainerStore<SimulationEvent>(database.container("events"));
    this.federation = new CosmosContainerStore<FederationStateDoc | OutboxItemDoc | InboxItemDoc>(
      database.container("federation")
    );
  }

  async getSimulation(id: string): Promise<Simulation | undefined> {
    return this.simulations.read(id, id);
  }

  async upsertSimulation(simulation: Simulation): Promise<void> {
    await this.simulations.upsert(simulation);
  }

  async deleteSimulationData(simulationId: string): Promise<void> {
    const [tiles, agents, constitutions, proposals, events, federation] = await Promise.all([
      this.listTiles(simulationId),
      this.listAgents(simulationId),
      this.listConstitutions(simulationId),
      this.listProposals(simulationId),
      this.events.queryBySimulation(simulationId),
      this.federation.queryBySimulation(simulationId)
    ]);

    await Promise.all([
      ...tiles.map((tile) => this.tiles.delete(tile.id, simulationId)),
      ...agents.map((agent) => this.agents.delete(agent.id, simulationId)),
      ...constitutions.map((constitution) => this.constitutions.delete(constitution.id, simulationId)),
      ...proposals.map((proposal) => this.proposals.delete(proposal.id, simulationId)),
      ...events.map((event) => this.events.delete(event.id, simulationId)),
      ...federation.map((doc) => this.federation.delete(doc.id, simulationId))
    ]);

    const simulation = await this.getSimulation(simulationId);
    if (simulation) {
      await this.simulations.delete(simulation.id, simulation.id);
    }
  }

  async listTiles(simulationId: string): Promise<Tile[]> {
    return this.tiles.queryBySimulation(simulationId);
  }

  async upsertTiles(tiles: Tile[]): Promise<void> {
    await Promise.all(tiles.map((tile) => this.tiles.upsert(tile)));
  }

  async listAgents(simulationId: string): Promise<AgentProfile[]> {
    return this.agents.queryBySimulation(simulationId);
  }

  async upsertAgent(agent: AgentProfile): Promise<void> {
    await this.agents.upsert(agent);
  }

  async listConstitutions(simulationId: string): Promise<ConstitutionVersion[]> {
    const constitutions = await this.constitutions.queryBySimulation(simulationId);
    return constitutions.sort((a, b) => b.version - a.version);
  }

  async upsertConstitution(version: ConstitutionVersion): Promise<void> {
    await this.constitutions.upsert(version);
  }

  async listProposals(simulationId: string): Promise<AmendmentProposal[]> {
    const proposals = await this.proposals.queryBySimulation(simulationId);
    return proposals.sort((a, b) => b.openedTurn - a.openedTurn);
  }

  async upsertProposal(proposal: AmendmentProposal): Promise<void> {
    await this.proposals.upsert(proposal);
  }

  async listRecentEvents(simulationId: string, limit: number): Promise<SimulationEvent[]> {
    return this.events.query({
      query: "SELECT * FROM c WHERE c.simulationId = @simulationId ORDER BY c.createdAt DESC OFFSET 0 LIMIT @limit",
      parameters: [
        { name: "@simulationId", value: simulationId },
        { name: "@limit", value: limit }
      ]
    });
  }

  async appendEvent(event: SimulationEvent): Promise<void> {
    await this.events.upsert(event);
  }

  async getFederationState(simulationId: string): Promise<FederationStateDoc | undefined> {
    const doc = await this.federation.read(FEDERATION_STATE_ID, simulationId);
    return doc?.kind === "state" ? (doc as FederationStateDoc) : undefined;
  }

  async putFederationState(state: FederationStateDoc): Promise<void> {
    await this.federation.upsert(state);
  }

  async listOutbox(simulationId: string, statuses?: OutboxStatus[]): Promise<OutboxItemDoc[]> {
    const docs = await this.federation.query({
      query: "SELECT * FROM c WHERE c.simulationId = @simulationId AND c.kind = 'outbox' ORDER BY c.createdAt ASC",
      parameters: [{ name: "@simulationId", value: simulationId }]
    });
    const items = docs.filter((doc): doc is OutboxItemDoc => doc.kind === "outbox");
    return statuses ? items.filter((item) => statuses.includes(item.status)) : items;
  }

  async putOutboxItem(item: OutboxItemDoc): Promise<void> {
    await this.federation.upsert(item);
  }

  async getInboxItem(simulationId: string, dedupeKey: string): Promise<InboxItemDoc | undefined> {
    const doc = await this.federation.read(`inbox_${dedupeKey}`, simulationId);
    return doc?.kind === "inbox" ? (doc as InboxItemDoc) : undefined;
  }

  async putInboxItem(item: InboxItemDoc): Promise<void> {
    await this.federation.upsert(item);
  }
}

export function createStore(config: AppConfig): SimulationStore {
  if (!config.cosmos) {
    return new MemorySimulationStore();
  }

  const client = new CosmosClient({
    endpoint: config.cosmos.endpoint,
    aadCredentials: new DefaultAzureCredential()
  });

  return new CosmosSimulationStore(client, config.cosmos.databaseId);
}

function deleteWhere<T>(map: Map<string, T>, predicate: (value: T) => boolean): void {
  for (const [key, value] of map.entries()) {
    if (predicate(value)) {
      map.delete(key);
    }
  }
}
