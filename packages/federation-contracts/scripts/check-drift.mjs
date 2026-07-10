// CI-friendly drift gate: regenerate all contract artifacts, then fail if the
// working tree changed (or has untracked generated files). Cross-platform
// (Windows + Linux) — relies only on `git status --porcelain` and node.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(pkgRoot, "..", "..");

// Paths (repo-relative) whose contents are generated and must not drift.
const GENERATED_PATHS = [
  "packages/federation-contracts/openapi/world.v1.bundled.json",
  "packages/federation-contracts/generated",
];

function git(args) {
  const res = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (res.status !== 0) {
    console.error(res.stderr || res.stdout);
    process.exit(res.status ?? 1);
  }
  return res.stdout ?? "";
}

// 1. Regenerate everything.
const gen = spawnSync("node", ["scripts/generate.mjs"], {
  cwd: pkgRoot,
  stdio: "inherit",
  shell: false,
});
if (gen.status !== 0) process.exit(gen.status ?? 1);

// 2. Detect any modified or untracked files under the generated paths.
const status = git(["status", "--porcelain", "--", ...GENERATED_PATHS]).trim();

if (status.length > 0) {
  console.error(
    "\nContract artifacts are out of date. Run `npm run generate:contracts` and commit the result.\n",
  );
  console.error("Drifted paths:\n" + status + "\n");
  console.error(git(["diff", "--", ...GENERATED_PATHS]));
  process.exit(1);
}

console.log("\nNo contract drift detected.");
