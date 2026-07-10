import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { components } from "@ai-civ/federation-contracts";
import { describe, expect, it } from "vitest";
import type { SigningFault, SyncResult } from "../src/fake-civilization.js";
import { loadScenario } from "../src/scenario/loader.js";
import { runScenario } from "../src/scenario/runner.js";
import type { ScenarioCivilization } from "../src/scenario/types.js";
import { ScenarioHostControlError } from "../src/scenario/types.js";
import { WorldHttpError } from "../src/transport.js";

class ScenarioActorStub implements ScenarioCivilization {
  readonly state = { online: true };
  registerCalls = 0;
  fault: SigningFault = "none";

  async register(): Promise<components["schemas"]["RegistrationResponse"]> {
    this.registerCalls += 1;
    return {
      civId: "civ_aurora",
      keyId: "key_aurora",
      protocolVersion: "1",
      registeredAt: "2026-01-01T00:00:00.000Z",
      duplicate: this.registerCalls > 1,
    };
  }

  async heartbeat(): Promise<components["schemas"]["HeartbeatAck"]> {
    if (this.fault !== "none") {
      throw new WorldHttpError(401, {
        type: "about:blank",
        title: "Unauthorized",
        status: 401,
        code: "invalid_signature",
      });
    }
    return { civId: "civ_aurora", serverTime: "2026-01-01T00:00:00.000Z" };
  }

  async pushEvents(): Promise<components["schemas"]["EventBatchResult"]> {
    return { results: [], acceptedCount: 0, duplicateCount: 0 };
  }

  async pull(): Promise<components["schemas"]["CommandPage"]> {
    return { items: [], nextCursor: null };
  }

  async sync(): Promise<SyncResult> {
    return {
      blockedOffline: !this.state.online,
      pages: this.state.online ? 1 : 0,
      applied: 0,
      rejected: 0,
      duplicates: 0,
      capped: false,
      cursor: null,
    };
  }

  async ack(commandId: string): Promise<components["schemas"]["CommandAckResult"]> {
    return { commandId, status: "applied" };
  }

  async submitInteraction(): Promise<components["schemas"]["Accepted"]> {
    return { status: "accepted", statusUrl: "/interactions/int-1", resourceId: "int-1" };
  }

  async getInteraction(interactionId: string): Promise<components["schemas"]["Interaction"]> {
    return {
      interactionId,
      kind: "contact",
      source: "civ_aurora",
      target: "civ_borealis",
      status: "acknowledged",
      public: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
  }

  async getCivilization(civId: string): Promise<components["schemas"]["PublicProjection"]> {
    return {
      civId,
      displayName: "Aurora",
      protocolVersion: "1",
      turn: 1,
      running: true,
      population: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  async listCivilizations(): Promise<components["schemas"]["CivilizationListPage"]> {
    return { items: [], nextCursor: null };
  }

  async listRelationships(): Promise<components["schemas"]["RelationshipPage"]> {
    return { items: [], nextCursor: null };
  }

  async listEvents(): Promise<components["schemas"]["EventPage"]> {
    return { items: [], nextCursor: null };
  }

  setSigningFault(fault: SigningFault): void {
    this.fault = fault;
  }
}

describe("scenario fixtures", () => {
  it("loads all checked-in versioned fixtures with JSON Pointer assertions", async () => {
    const directory = new URL("../scenarios/", import.meta.url);
    const files = (await readdir(directory)).filter((name) => name.endsWith(".scenario.json"));
    expect(files).toHaveLength(6);
    for (const file of files) {
      const scenario = await loadScenario(fileURLToPath(new URL(file, directory)));
      expect(scenario.schemaVersion).toBe("1");
      for (const step of scenario.steps) {
        if (step.op === "assert") expect(step.actual.startsWith("/")).toBe(true);
      }
    }
  });

  it("replays prior operations, matches expected errors, and uses primitive assertions", async () => {
    const actor = new ScenarioActorStub();
    const result = await runScenario({
      schemaVersion: "1",
      name: "runner",
      actors: {
        aurora: {
          displayName: "Aurora",
          credentialRef: "aurora",
          capabilities: { protocolVersion: "1.0.0", supportedInteractionKinds: ["contact"] },
        },
      },
      steps: [
        { id: "register", op: "register", actor: "aurora", idempotencyKey: "register-1" },
        { op: "replay", stepId: "register", saveAs: "duplicate" },
        { op: "assert", actual: "/duplicate/duplicate", equals: true },
        { op: "setAuthFault", actor: "aurora", fault: "invalid-signature" },
        { op: "heartbeat", actor: "aurora", expectError: { status: 401, code: "invalid_signature" }, saveAs: "authError" },
        { op: "assert", actual: "/authError/status", equals: 401 },
      ],
    }, { createActor: () => actor });
    expect(result.completedSteps).toBe(6);
    expect(actor.registerCalls).toBe(2);
  });

  it("rejects arrange without injected host controls", async () => {
    await expect(runScenario({
      schemaVersion: "1",
      name: "host required",
      actors: {},
      steps: [{ op: "arrange", action: "queueCommand" }],
    }, {
      createActor: () => new ScenarioActorStub(),
    })).rejects.toBeInstanceOf(ScenarioHostControlError);
  });

  it("rejects operations outside the fixed DSL during loading", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fake-civ-scenario-"));
    const path = join(directory, "invalid.json");
    await writeFile(path, JSON.stringify({
      schemaVersion: "1",
      name: "invalid",
      actors: {},
      steps: [{ op: "eval", value: "process.exit()" }],
    }), "utf8");
    try {
      await expect(loadScenario(path)).rejects.toThrow("Unsupported scenario operation");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
