// Deterministic contract code generation for BOTH sides of the federation.
//
// Pipeline:
//   1. redocly bundle          -> openapi/world.v1.bundled.json  (single-file source for generators)
//   2. openapi-typescript      -> generated/ts/world.v1.d.ts     (TypeScript types)
//   3. kiota generate (CSharp) -> generated/csharp/**            (C# client + models)
//
// Always invoked via `npm run generate` so node_modules/.bin (redocly, openapi-typescript)
// is on PATH, and `dotnet kiota` resolves from the pinned .config/dotnet-tools.json manifest.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(pkgRoot, "..", "..");

const OPENAPI = "openapi/world.v1.yaml";
const BUNDLED = "openapi/world.v1.bundled.json";

function run(cmd, opts = {}) {
  console.log(`\n$ ${cmd}`);
  const res = spawnSync(cmd, {
    cwd: opts.cwd ?? pkgRoot,
    stdio: "inherit",
    shell: true,
  });
  if (res.status !== 0) {
    console.error(`\nCommand failed (exit ${res.status}): ${cmd}`);
    process.exit(res.status ?? 1);
  }
}

// 1. Bundle the modular OpenAPI into a single deterministic JSON document.
run(`redocly bundle ${OPENAPI} -o ${BUNDLED} --ext json`);

// 2. TypeScript types (pure types, no runtime; faithful OpenAPI 3.1 support).
//    Use the shared redocly.yaml so lint rules match the `redocly lint` gate.
run(`openapi-typescript ${BUNDLED} -o generated/ts/world.v1.d.ts --root-types --redocly redocly.yaml`);

// 3. C# client + models via the pinned Kiota dotnet tool (restored from the manifest).
//    Run from repo root so `dotnet tool run` finds .config/dotnet-tools.json.
run("dotnet tool restore", { cwd: repoRoot });
run(
  [
    "dotnet tool run kiota generate",
    "--language CSharp",
    "--class-name WorldFederationClient",
    "--namespace-name AiCiv.FederationContracts",
    `--openapi packages/federation-contracts/${BUNDLED}`,
    "--output packages/federation-contracts/generated/csharp",
    "--clean-output",
    "--exclude-backward-compatible",
    "--log-level Warning",
  ].join(" "),
  { cwd: repoRoot },
);

console.log("\nContract generation complete.");

// Kiota writes a per-run log file; it is deterministic but noise. Remove it so
// it is neither committed nor flagged by the drift gate.
import { rmSync } from "node:fs";
rmSync(resolve(pkgRoot, "generated/csharp/.kiota.log"), { force: true });
