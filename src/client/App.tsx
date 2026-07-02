import { useEffect, useMemo, useState } from "react";
import type { AgentProfile, SimulationEvent, Tile, WorldSnapshot } from "../shared/types.js";

const terrainIcons: Record<string, string> = {
  grass: "",
  water: "~",
  stone: "^",
  farm: "#",
  forum: "O",
  forest: "*"
};

export function App() {
  const [snapshot, setSnapshot] = useState<WorldSnapshot | undefined>();
  const [selectedAgentId, setSelectedAgentId] = useState<string | undefined>();
  const [showHistory, setShowHistory] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function loadWorld() {
    const response = await fetch("/api/world");
    if (!response.ok) {
      throw new Error(`World request failed: ${response.status}`);
    }
    setSnapshot(await response.json() as WorldSnapshot);
  }

  useEffect(() => {
    loadWorld().catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : "Failed to load world."));

    const stream = new EventSource("/api/stream");
    stream.onmessage = () => {
      loadWorld().catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : "Failed to refresh world."));
    };

    const refreshEvents = [
      "turnAdvanced",
      "agentUpdated",
      "proposalOpened",
      "voteCast",
      "constitutionAmended",
      "proposalFailed",
      "tileChanged",
      "conversation",
      "actionRejected"
    ];

    for (const eventName of refreshEvents) {
      stream.addEventListener(eventName, () => {
        loadWorld().catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : "Failed to refresh world."));
      });
    }

    stream.onerror = () => setError("Live stream disconnected. The browser will retry automatically.");
    return () => stream.close();
  }, []);

  const selectedAgent = useMemo(
    () => snapshot?.agents.find((agent) => agent.id === selectedAgentId) ?? snapshot?.agents[0],
    [selectedAgentId, snapshot?.agents]
  );

  if (!snapshot) {
    return <main className="shell"><p>{error ?? "Waking the tiny republic..."}</p></main>;
  }

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">AI Civilization Sandbox</p>
          <h1>Turn {snapshot.simulation.turn}</h1>
          <p>{snapshot.simulation.running ? "Autonomous deliberation is running." : "Simulation is paused."}</p>
        </div>
        <button type="button" onClick={() => setShowHistory((value) => !value)}>
          {showHistory ? "Current constitution" : "Constitution history"}
        </button>
      </header>

      {error ? <div className="warning">{error}</div> : null}

      <section className="layout">
        <WorldGrid tiles={snapshot.tiles} agents={snapshot.agents} worldSize={snapshot.simulation.config.worldSize} onSelectAgent={setSelectedAgentId} />
        <aside className="panel">
          <h2>Citizens</h2>
          <div className="agentList">
            {snapshot.agents.map((agent) => (
              <button
                type="button"
                className={agent.id === selectedAgent?.id ? "agentCard selected" : "agentCard"}
                key={agent.id}
                onClick={() => setSelectedAgentId(agent.id)}
              >
                <strong>{agent.name}</strong>
                <span>{agent.model}</span>
              </button>
            ))}
          </div>

          {selectedAgent ? <AgentDetails agent={selectedAgent} /> : null}
        </aside>
      </section>

      <section className="bottom">
        <Constitution snapshot={snapshot} showHistory={showHistory} />
        <Proposals snapshot={snapshot} />
        <Events events={snapshot.recentEvents} />
      </section>
    </main>
  );
}

function WorldGrid({
  tiles,
  agents,
  worldSize,
  onSelectAgent
}: {
  tiles: Tile[];
  agents: AgentProfile[];
  worldSize: number;
  onSelectAgent: (agentId: string) => void;
}) {
  const tileMap = new Map(tiles.map((tile) => [`${tile.position.x}:${tile.position.y}`, tile]));
  const agentMap = new Map(agents.map((agent) => [`${agent.position.x}:${agent.position.y}`, agent]));

  return (
    <section className="world" aria-label="Simulation world">
      {Array.from({ length: worldSize * worldSize }, (_, index) => {
        const x = index % worldSize;
        const y = Math.floor(index / worldSize);
        const tile = tileMap.get(`${x}:${y}`);
        const agent = agentMap.get(`${x}:${y}`);
        return (
          <button
            type="button"
            key={`${x}:${y}`}
            className={`tile terrain-${tile?.terrain ?? "grass"}`}
            title={`${tile?.terrain ?? "grass"} (${x}, ${y})${agent ? ` - ${agent.name}` : ""}`}
            onClick={() => agent ? onSelectAgent(agent.id) : undefined}
          >
            {agent ? <span className="agentToken">{agent.name.slice(0, 1)}</span> : terrainIcons[tile?.terrain ?? "grass"]}
          </button>
        );
      })}
    </section>
  );
}

function AgentDetails({ agent }: { agent: AgentProfile }) {
  return (
    <section className="agentDetails">
      <h3>{agent.name}</h3>
      <p className="muted">Position ({agent.position.x}, {agent.position.y})</p>
      <TagList title="Principles" items={agent.corePrinciples} />
      <TagList title="Traits" items={agent.personalityTraits} />
      <TagList title="Goals" items={agent.goals} />
      <h4>Recent memories</h4>
      <ul>
        {agent.memorySummaries.slice(-4).map((memory) => <li key={memory}>{memory}</li>)}
      </ul>
    </section>
  );
}

function TagList({ title, items }: { title: string; items: string[] }) {
  return (
    <>
      <h4>{title}</h4>
      <div className="tags">
        {items.map((item) => <span key={item}>{item}</span>)}
      </div>
    </>
  );
}

function Constitution({ snapshot, showHistory }: { snapshot: WorldSnapshot; showHistory: boolean }) {
  return (
    <section className="card">
      <h2>{showHistory ? "Constitution history" : `Constitution v${snapshot.currentConstitution.version}`}</h2>
      {showHistory ? (
        <div className="history">
          {snapshot.constitutionHistory.map((version) => (
            <details key={version.id}>
              <summary>Version {version.version} - turn {version.createdAtTurn}</summary>
              <pre>{version.text}</pre>
            </details>
          ))}
        </div>
      ) : (
        <pre>{snapshot.currentConstitution.text}</pre>
      )}
    </section>
  );
}

function Proposals({ snapshot }: { snapshot: WorldSnapshot }) {
  return (
    <section className="card">
      <h2>Amendments</h2>
      {snapshot.proposals.length === 0 ? <p className="muted">No proposals yet.</p> : null}
      {snapshot.proposals.slice(0, 5).map((proposal) => (
        <article className="proposal" key={proposal.id}>
          <h3>{proposal.title}</h3>
          <p>{proposal.proposedText}</p>
          <small>{proposal.status} - closes turn {proposal.closesTurn} - {proposal.votes.length} votes</small>
        </article>
      ))}
    </section>
  );
}

function Events({ events }: { events: SimulationEvent[] }) {
  return (
    <section className="card">
      <h2>Recent events</h2>
      <ol className="events">
        {events.slice(0, 14).map((event) => (
          <li key={event.id}>
            <strong>T{event.turn}</strong> {event.message}
          </li>
        ))}
      </ol>
    </section>
  );
}
