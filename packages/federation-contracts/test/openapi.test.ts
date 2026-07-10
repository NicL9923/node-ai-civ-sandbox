import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type OpenApiDoc = {
  openapi: string;
  paths: Record<string, Record<string, { operationId?: string }>>;
  components: { schemas: Record<string, unknown> };
};

const bundled = JSON.parse(
  readFileSync(resolve(pkgRoot, "openapi/world.v1.bundled.json"), "utf8"),
) as OpenApiDoc;

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "patch", "options", "head"]);

function collectOperationIds(doc: OpenApiDoc): string[] {
  const ids: string[] = [];
  for (const item of Object.values(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (HTTP_METHODS.has(method) && op.operationId) ids.push(op.operationId);
    }
  }
  return ids;
}

function collectRefs(node: unknown, acc: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const v of node) collectRefs(v, acc);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "$ref" && typeof v === "string") acc.push(v);
      else collectRefs(v, acc);
    }
  }
  return acc;
}

describe("bundled OpenAPI document", () => {
  it("is OpenAPI 3.1", () => {
    expect(bundled.openapi).toMatch(/^3\.1\./);
  });

  it("is fully self-contained (all $refs are internal after bundling)", () => {
    const external = collectRefs(bundled).filter((r) => !r.startsWith("#/"));
    expect(external).toEqual([]);
  });

  it("defines every required World operation", () => {
    const ids = new Set(collectOperationIds(bundled));
    const required = [
      "registerCivilization",
      "heartbeatCivilization",
      "listCivilizations",
      "getCivilization",
      "ingestEventBatch",
      "pullCommands",
      "ackCommand",
      "submitInteraction",
      "getInteraction",
      "listRelationships",
      "listWorldEvents",
      "streamWorldEvents",
    ];
    for (const id of required) expect(ids.has(id)).toBe(true);
  });

  it("gives every operation a unique operationId", () => {
    const ids = collectOperationIds(bundled);
    expect(ids.length).toBe(new Set(ids).size);
  });

  it("uses colon custom-method paths for register, batch, and ack", () => {
    const paths = Object.keys(bundled.paths);
    expect(paths).toContain("/civilizations:register");
    expect(paths.some((p) => p.endsWith("/events:batch"))).toBe(true);
    expect(paths.some((p) => p.endsWith(":ack"))).toBe(true);
  });
});
