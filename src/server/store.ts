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

export interface SimulationStore {
  getSimulation(id: string): Promise<Simulation | undefined>;
  upsertSimulation(simulation: Simulation): Promise<void>;
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
}

export class MemorySimulationStore implements SimulationStore {
  private simulations = new Map<string, Simulation>();
  private tiles = new Map<string, Tile>();
  private agents = new Map<string, AgentProfile>();
  private constitutions = new Map<string, ConstitutionVersion>();
  private proposals = new Map<string, AmendmentProposal>();
  private events = new Map<string, SimulationEvent>();

  async getSimulation(id: string): Promise<Simulation | undefined> {
    return this.simulations.get(id);
  }

  async upsertSimulation(simulation: Simulation): Promise<void> {
    this.simulations.set(simulation.id, simulation);
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

  constructor(client: CosmosClient, databaseId: string) {
    const database = client.database(databaseId);
    this.simulations = new CosmosContainerStore<Simulation>(database.container("simulations"));
    this.tiles = new CosmosContainerStore<Tile>(database.container("tiles"));
    this.agents = new CosmosContainerStore<AgentProfile>(database.container("agents"));
    this.constitutions = new CosmosContainerStore<ConstitutionVersion>(database.container("constitutions"));
    this.proposals = new CosmosContainerStore<AmendmentProposal>(database.container("proposals"));
    this.events = new CosmosContainerStore<SimulationEvent>(database.container("events"));
  }

  async getSimulation(id: string): Promise<Simulation | undefined> {
    return this.simulations.read(id, id);
  }

  async upsertSimulation(simulation: Simulation): Promise<void> {
    await this.simulations.upsert(simulation);
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
