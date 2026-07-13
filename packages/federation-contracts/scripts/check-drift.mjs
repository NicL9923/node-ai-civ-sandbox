// CI-friendly drift gate: regenerate all contract artifacts, then fail if the
// generated output differs from what is committed. Cross-platform (Windows +
// Linux): we stage the generated paths with `git add` so the repo's
// .gitattributes clean filter (eol=lf) is applied, then compare with
// `git diff --cached`. This ignores EOL-only phantom changes (Kiota emits CRLF
// on Windows) while still catching real content changes AND new/removed files.
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

function git(args, opts = {}) {
  const res = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", ...opts });
  if (res.status !== 0 && !opts.allowFailure) {
    console.error(res.stderr || res.stdout);
    process.exit(res.status ?? 1);
  }
  return res;
}

// 1. Regenerate everything.
const gen = spawnSync("node", ["scripts/generate.mjs"], {
  cwd: pkgRoot,
  stdio: "inherit",
  shell: false,
});
if (gen.status !== 0) process.exit(gen.status ?? 1);

// 2. Stage the generated paths so .gitattributes normalization is applied.
git(["add", "--", ...GENERATED_PATHS]);

// 3. Compare the staged tree with HEAD. `--quiet` exits 1 on any real diff
//    (content changes, additions, or deletions); EOL-only changes normalize away.
const check = git(["diff", "--cached", "--quiet", "--", ...GENERATED_PATHS], {
  allowFailure: true,
});

if (check.status !== 0) {
  console.error(
    "\nContract artifacts are out of date. Run `npm run generate:contracts` and commit the result.\n",
  );
  console.error(git(["diff", "--cached", "--stat", "--", ...GENERATED_PATHS]).stdout);
  git(["reset", "--quiet", "--", ...GENERATED_PATHS], { allowFailure: true });
  process.exit(1);
}

// Leave the index as we found it.
git(["reset", "--quiet", "--", ...GENERATED_PATHS], { allowFailure: true });
console.log("\nNo contract drift detected.");
