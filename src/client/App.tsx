import { useEffect, useMemo, useState } from "react";
import type { AgentProfile, AmendmentProposal, PresidentTerm, SimulationEvent, SimulationEventType, Tile, Vote, VoteChoice, WorldSnapshot } from "../shared/types.js";

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
      "actionRejected",
      "resourcesGathered",
      "resourcesTransferred",
      "electionOpened",
      "candidacyDeclared",
      "ballotCast",
      "presidentElected",
      "taxCollected",
      "treasurySpent",
      "lawEnacted",
      "decreeIssued",
      "violationRecorded",
      "fineIssued",
      "pardonIssued",
      "policyChanged"
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

  const president = snapshot?.simulation.governance?.president;

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
            {snapshot.agents.map((agent) => {
              const isPresident = agent.id === president?.agentId;
              return (
                <button
                  type="button"
                  className={agent.id === selectedAgent?.id ? "agentCard selected" : "agentCard"}
                  key={agent.id}
                  onClick={() => setSelectedAgentId(agent.id)}
                >
                  <span className="agentCardMain">
                    <strong>{agent.name}</strong>
                    {isPresident ? <span className="presidentBadge" title="President" aria-label="President">★</span> : null}
                  </span>
                  <span className="agentCardMeta">
                    <span className="muted">{agent.model}</span>
                    <span className="resourceChip" title={`${agent.resources} resources`}>
                      <span aria-hidden="true">◈</span> {agent.resources}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          {selectedAgent ? <AgentDetails agent={selectedAgent} president={president} /> : null}
        </aside>
      </section>

      <Government snapshot={snapshot} />

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
        const productivity = tile?.productivity;
        const isProductive = typeof productivity === "number" && productivity > 0;
        const productivityNote = isProductive
          ? ` - yield ${productivity}${typeof tile?.maxProductivity === "number" ? `/${tile.maxProductivity}` : ""}`
          : "";
        return (
          <button
            type="button"
            key={`${x}:${y}`}
            className={`tile terrain-${tile?.terrain ?? "grass"}${isProductive ? " productive" : ""}`}
            title={`${tile?.terrain ?? "grass"} (${x}, ${y})${productivityNote}${agent ? ` - ${agent.name}` : ""}`}
            onClick={() => agent ? onSelectAgent(agent.id) : undefined}
          >
            {agent ? <span className="agentToken">{agent.name.slice(0, 1)}</span> : terrainIcons[tile?.terrain ?? "grass"]}
          </button>
        );
      })}
    </section>
  );
}

function AgentDetails({ agent, president }: { agent: AgentProfile; president?: PresidentTerm }) {
  const isPresident = agent.id === president?.agentId;
  return (
    <section className="agentDetails">
      <h3>{agent.name}</h3>
      <p className="muted">Position ({agent.position.x}, {agent.position.y})</p>
      <div className="agentStatRow">
        <span className="resourceChip lg" title="Resource wallet">
          <span aria-hidden="true">◈</span> {agent.resources} resources
        </span>
        {isPresident ? (
          <span className="presidentPill" title="Head of state">
            <span aria-hidden="true">★</span> President · Term {president?.termNumber}
          </span>
        ) : null}
      </div>
      {isPresident && president?.platform ? <p className="muted platformNote">“{president.platform}”</p> : null}
      <TagList title="Principles" items={agent.corePrinciples} />
      <TagList title="Traits" items={agent.personalityTraits} />
      <TagList title="Goals" items={agent.goals} />
      <div className="sectionHeader">
        <h4>Recent memories</h4>
        <span className="muted">{agent.memorySummaries.length} stored</span>
      </div>
      <ol className="memoryList" aria-label={`${agent.name}'s recent memories`}>
        {agent.memorySummaries.slice(-8).reverse().map((memory, index) => (
          <li key={`${agent.id}-memory-${index}-${memory.slice(0, 24)}`}>
            <details open={index === 0}>
              <summary>{memory.length > 88 ? `${memory.slice(0, 88)}...` : memory}</summary>
              <p>{memory}</p>
            </details>
          </li>
        ))}
      </ol>
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
  const agentNameById = useMemo(() => new Map(snapshot.agents.map((agent) => [agent.id, agent.name])), [snapshot.agents]);
  const openProposals = snapshot.proposals.filter((proposal) => proposal.status === "open");
  const closedProposals = snapshot.proposals.filter((proposal) => proposal.status !== "open");

  return (
    <section className="card">
      <h2>Amendments</h2>
      {snapshot.proposals.length === 0 ? <p className="muted">No proposals yet.</p> : null}
      {snapshot.proposals.length > 0 ? (
        <div className="proposalAccordions">
          <ProposalSection
            title="Open votes"
            proposals={openProposals}
            emptyText="No open votes."
            defaultOpen
            snapshot={snapshot}
            agentNameById={agentNameById}
          />
          <ProposalSection
            title="Closed votes"
            proposals={closedProposals}
            emptyText="No closed votes yet."
            snapshot={snapshot}
            agentNameById={agentNameById}
          />
        </div>
      ) : null}
    </section>
  );
}

function ProposalSection({
  title,
  proposals,
  emptyText,
  defaultOpen = false,
  snapshot,
  agentNameById
}: {
  title: string;
  proposals: AmendmentProposal[];
  emptyText: string;
  defaultOpen?: boolean;
  snapshot: WorldSnapshot;
  agentNameById: Map<string, string>;
}) {
  return (
    <details className="proposalSection" open={defaultOpen}>
      <summary>
        <span>{title}</span>
        <span className="sectionCount">{proposals.length}</span>
      </summary>
      {proposals.length === 0 ? <p className="muted">{emptyText}</p> : null}
      {proposals.slice(0, 8).map((proposal) => (
        <ProposalCard key={proposal.id} proposal={proposal} snapshot={snapshot} agentNameById={agentNameById} />
      ))}
    </details>
  );
}

function ProposalCard({
  proposal,
  snapshot,
  agentNameById
}: {
  proposal: AmendmentProposal;
  snapshot: WorldSnapshot;
  agentNameById: Map<string, string>;
}) {
  return (
    <article className="proposal">
      <div className="proposalHeader">
        <h3>{proposal.title}</h3>
        <span className={`statusPill status-${proposal.status}`}>{proposal.status}</span>
      </div>
      {proposal.changeType && proposal.changeType !== "add" ? (
        <p className="muted">
          {proposal.changeType === "repeal" ? "Repeals" : "Revises"}
          {proposal.targetReference ? ` ${proposal.targetReference}` : " a prior provision"}
        </p>
      ) : null}
      <p>{proposal.proposedText}</p>
      <p className="muted">Proposer rationale: {proposal.rationale}</p>
      <VoteSummary
        proposal={proposal}
        totalAgents={snapshot.agents.filter((agent) => agent.active).length}
        currentTurn={snapshot.simulation.turn}
        quorumRatio={snapshot.simulation.config.quorumRatio}
        supermajorityRatio={snapshot.simulation.config.supermajorityRatio}
      />
      {proposal.votes.length > 0 ? <VoteDetails votes={proposal.votes} agentNameById={agentNameById} /> : <p className="muted">No votes yet.</p>}
    </article>
  );
}

function VoteSummary({
  proposal,
  totalAgents,
  currentTurn,
  quorumRatio,
  supermajorityRatio
}: {
  proposal: AmendmentProposal;
  totalAgents: number;
  currentTurn: number;
  quorumRatio: number;
  supermajorityRatio: number;
}) {
  const counts = countVotes(proposal.votes);
  const castVotes = proposal.votes.length;
  const decisiveVotes = counts.yes + counts.no;
  const requiredQuorum = Math.ceil(totalAgents * quorumRatio);
  const requiredYays = decisiveVotes === 0 ? Math.ceil(totalAgents * supermajorityRatio) : Math.ceil(decisiveVotes * supermajorityRatio);
  const closesIn = Math.max(0, proposal.closesTurn - currentTurn);
  const totalForBar = Math.max(1, castVotes);

  return (
    <div className="voteSummary" aria-label={`Votes: ${counts.yes} yay, ${counts.no} nay, ${counts.abstain} abstain`}>
      <div className="voteCounts">
        <VoteCount label="Yay" count={counts.yes} choice="yes" />
        <VoteCount label="Nay" count={counts.no} choice="no" />
        <VoteCount label="Abstain" count={counts.abstain} choice="abstain" />
      </div>
      <div className="voteBar" aria-hidden="true">
        <span className="voteBarYes" style={{ flexGrow: counts.yes / totalForBar }} />
        <span className="voteBarNo" style={{ flexGrow: counts.no / totalForBar }} />
        <span className="voteBarAbstain" style={{ flexGrow: counts.abstain / totalForBar }} />
      </div>
      <div className="voteRules">
        <span>Quorum: {castVotes}/{totalAgents} voted {castVotes >= requiredQuorum ? "met" : `needs ${requiredQuorum}`}</span>
        <span>Supermajority: {counts.yes}/{Math.max(1, decisiveVotes)} yays {counts.yes >= requiredYays ? "met" : `needs ${requiredYays}`}</span>
        <span>{proposal.status === "open" ? `Closes in: ${closesIn} turns` : `Resolved ${proposal.resolvedAt ? new Date(proposal.resolvedAt).toLocaleString() : "recently"}`}</span>
      </div>
    </div>
  );
}

function VoteCount({ label, count, choice }: { label: string; count: number; choice: VoteChoice }) {
  return (
    <span className={`voteCount vote-${choice}`}>
      <strong>{count}</strong> {label}
    </span>
  );
}

function VoteDetails({ votes, agentNameById }: { votes: Vote[]; agentNameById: Map<string, string> }) {
  return (
    <details className="voteDetails">
      <summary>Individual votes</summary>
      <ul>
        {votes.map((vote) => (
          <li key={`${vote.agentId}-${vote.turn}`}>
            <span className={`voteBadge vote-${vote.choice}`}>{vote.choice}</span>
            <strong>{agentNameById.get(vote.agentId) ?? vote.agentId}</strong>
            <span className="muted">T{vote.turn}</span>
            <p>{vote.rationale}</p>
          </li>
        ))}
      </ul>
    </details>
  );
}

function countVotes(votes: Vote[]): Record<VoteChoice, number> {
  return votes.reduce<Record<VoteChoice, number>>(
    (counts, vote) => {
      counts[vote.choice] += 1;
      return counts;
    },
    { yes: 0, no: 0, abstain: 0 }
  );
}

function Government({ snapshot }: { snapshot: WorldSnapshot }) {
  const { agents } = snapshot;
  const governance = snapshot.simulation.governance;
  const nameById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.name])), [agents]);
  const nameOf = (id?: string) => (id ? nameById.get(id) ?? id : "Unknown");

  if (!governance) {
    return null;
  }

  const president = governance.president;
  const election = governance.election;
  const activeLaws = governance.laws.filter((law) => law.active);
  const pendingViolations = governance.violations.filter((violation) => violation.status === "pending");
  const finedCount = governance.violations.filter((violation) => violation.status === "fined").length;
  const pardonedCount = governance.violations.filter((violation) => violation.status === "pardoned").length;

  const powers = [
    { label: "Tax", on: governance.params.presidentCanTax },
    { label: "Spend", on: governance.params.presidentCanSpend },
    { label: "Fine", on: governance.params.presidentCanFine },
    { label: "Pardon", on: governance.params.presidentCanPardon },
    { label: "Decree", on: governance.params.presidentCanDecree }
  ];

  const params = [
    { label: "President term", value: `${governance.params.presidentTermTurns} turns` },
    { label: "Proposal cost", value: governance.params.proposalCost },
    { label: "Change-tile cost", value: governance.params.changeTileCost },
    { label: "Tax cap / action", value: governance.params.taxCapPerAction },
    { label: "Fine max", value: governance.params.fineMax }
  ];

  const tallies = new Map<string, number>();
  for (const ballot of election?.ballots ?? []) {
    tallies.set(ballot.candidateId, (tallies.get(ballot.candidateId) ?? 0) + 1);
  }
  const electionOpen = election?.status === "open";

  return (
    <section className="card government">
      <div className="govHeader">
        <h2>Government</h2>
        <span className="treasuryChip" title="Public treasury">
          <span className="muted">Treasury</span> <span aria-hidden="true">◈</span> {governance.treasury}
        </span>
      </div>

      <div className="govGrid">
        <div className="govBlock">
          <h4>Executive</h4>
          {president ? (
            <>
              <p className="govLead"><span aria-hidden="true">★</span> {nameOf(president.agentId)}</p>
              <p className="muted">Term {president.termNumber} · since turn {president.termStartedTurn}</p>
              {president.platform ? <p className="platformNote">“{president.platform}”</p> : null}
            </>
          ) : (
            <p className="govLead vacant">Vacant</p>
          )}
          <div className="powerPills" aria-label="Presidential powers">
            {powers.map((power) => (
              <span key={power.label} className={power.on ? "powerPill on" : "powerPill off"}>
                {power.label}
              </span>
            ))}
          </div>
        </div>

        <div className="govBlock">
          <h4>Governable parameters</h4>
          <dl className="statList">
            {params.map((param) => (
              <div className="statRow" key={param.label}>
                <dt className="muted">{param.label}</dt>
                <dd>{param.value}</dd>
              </div>
            ))}
          </dl>
        </div>

        {electionOpen && election ? (
          <div className="govBlock electionBlock">
            <div className="electionHeader">
              <h4>Election open</h4>
              <span className="closesPill">closes turn {election.closesTurn}</span>
            </div>
            {election.candidates.length === 0 ? (
              <p className="muted">Awaiting candidates.</p>
            ) : (
              <ul className="candidateList">
                {election.candidates.map((candidate) => {
                  const votes = tallies.get(candidate.agentId) ?? 0;
                  const share = election.ballots.length > 0 ? votes / election.ballots.length : 0;
                  return (
                    <li key={candidate.agentId} className="candidate">
                      <div className="candidateTop">
                        <strong>{nameOf(candidate.agentId)}</strong>
                        <span className="tallyCount">{votes} {votes === 1 ? "vote" : "votes"}</span>
                      </div>
                      <div className="tallyBar" aria-hidden="true">
                        <span style={{ inlineSize: `${Math.round(share * 100)}%` }} />
                      </div>
                      <p className="muted">{candidate.platform}</p>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : election?.winnerAgentId ? (
          <div className="govBlock">
            <h4>Last election</h4>
            <p className="govLead"><span aria-hidden="true">★</span> {nameOf(election.winnerAgentId)}</p>
            <p className="muted">Elected · closed turn {election.closesTurn}</p>
          </div>
        ) : null}

        <div className="govBlock">
          <div className="electionHeader">
            <h4>Active laws</h4>
            <span className="closesPill subtle">{activeLaws.length}</span>
          </div>
          {activeLaws.length === 0 ? (
            <p className="muted">No laws in force.</p>
          ) : (
            <ul className="lawList">
              {activeLaws.map((law) => (
                <li key={law.id} className="lawItem">
                  <div className="lawTop">
                    <strong>{law.title}</strong>
                    <span className={`lawType law-${law.type}`}>{law.type}</span>
                  </div>
                  <p>{law.description}</p>
                  {law.type === "prohibition" && law.forbiddenAction ? (
                    <p className="muted">Forbids: <code>{law.forbiddenAction}</code></p>
                  ) : null}
                  {law.type === "tax" && typeof law.amount === "number" ? (
                    <p className="muted">Amount: {law.amount}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="govBlock">
          <div className="electionHeader">
            <h4>Violations</h4>
            <span className="closesPill subtle">{pendingViolations.length} pending</span>
          </div>
          {pendingViolations.length === 0 ? (
            <p className="muted">No pending violations.</p>
          ) : (
            <ul className="violationList">
              {pendingViolations.map((violation) => (
                <li key={violation.id} className="violationItem">
                  <div className="lawTop">
                    <strong>{nameOf(violation.agentId)}</strong>
                    <span className="lawType law-violation">T{violation.turn}</span>
                  </div>
                  <p className="muted">{violation.lawTitle}</p>
                </li>
              ))}
            </ul>
          )}
          {finedCount + pardonedCount > 0 ? (
            <p className="muted resolvedNote">{finedCount} fined · {pardonedCount} pardoned</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function eventTone(type: SimulationEventType): "gov" | "econ" | "warn" | "neutral" {
  switch (type) {
    case "presidentElected":
    case "electionOpened":
    case "candidacyDeclared":
    case "lawEnacted":
    case "decreeIssued":
    case "policyChanged":
    case "constitutionAmended":
      return "gov";
    case "resourcesGathered":
    case "resourcesTransferred":
    case "taxCollected":
    case "treasurySpent":
      return "econ";
    case "violationRecorded":
    case "fineIssued":
    case "actionRejected":
    case "proposalFailed":
      return "warn";
    default:
      return "neutral";
  }
}

function Events({ events }: { events: SimulationEvent[] }) {
  return (
    <section className="card">
      <h2>Recent events</h2>
      <ul className="events">
        {events.slice(0, 14).map((event) => (
          <li key={event.id}>
            <span className={`eventDot tone-${eventTone(event.type)}`} aria-hidden="true" />
            <strong>T{event.turn}</strong> {event.message}
          </li>
        ))}
      </ul>
    </section>
  );
}
