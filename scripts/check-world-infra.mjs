#!/usr/bin/env node
// =====================================================================================================
// check-world-infra.mjs — zero-dependency IaC + deployment-tooling guardrails for the World deployment.
//
//   (1) Container parity: infra/world/containers.json MUST match WorldMap.Infrastructure.Cosmos
//       .CosmosContainers (`All`, `TtlContainers`, `PartitionKeyPath`).
//   (2) No-secret scan: World Bicep/param/json files AND the deployment tooling (Justfile, runbook,
//       helper scripts) MUST NOT contain raw secret VALUES. The secret map MUST be wired via a
//       versionless Key Vault SecretUri reference; purge protection MUST be unconditional.
//   (3) Onboarding records: statically validate shape/format/uniqueness/ordering of onboardingRecords.
//   (4) Secret-handling hygiene: deployment tooling MUST NOT use a non-CSPRNG generator, pass secrets
//       as CLI --value args, or print/emit raw token/HMAC/secret variables.
//   (5) Deploy tooling: the package/deploy scripts MUST verify checksums and gate on readiness.
//
// The detector primitives (RAW_VALUE_DENYLIST, SECRET_HANDLING_DENYLIST, scanContent) are exported so
// scripts/check-world-infra.selftest.mjs can assert they catch adversarial fixtures.
//
// Exit code 0 = all checks pass; 1 = a check failed.
// =====================================================================================================

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

const WORLD_INFRA_DIR = resolve(repoRoot, 'infra/world');
const SCRIPTS_DIR = resolve(repoRoot, 'scripts');
const CONTAINERS_JSON = resolve(WORLD_INFRA_DIR, 'containers.json');
const BICEPPARAM = resolve(WORLD_INFRA_DIR, 'main.bicepparam');
const MAIN_BICEP = resolve(WORLD_INFRA_DIR, 'main.bicep');
const DEPLOY_SCRIPT = resolve(SCRIPTS_DIR, 'deploy-world-app.ps1');
const PACKAGE_SCRIPT = resolve(SCRIPTS_DIR, 'package-world-app.ps1');
const COSMOS_CONTAINERS_CS = resolve(
  repoRoot,
  'apps/world-map/src/WorldMap.Infrastructure/Cosmos/CosmosContainers.cs',
);
const RUNBOOK = resolve(repoRoot, 'docs/world-deployment-runbook.md');

// Scan EVERY hand-authored file in infra/world so a secret in a new bicep/param/json file is covered.
const INFRA_FILES = readdirSync(WORLD_INFRA_DIR)
  .filter((f) => /\.(bicep|bicepparam|json)$/.test(f))
  .map((f) => resolve(WORLD_INFRA_DIR, f));

// Deployment tooling that handles secrets/tokens operationally: the Justfile, the runbook, and any
// World/onboarding/secret helper script (dynamically discovered, so a new helper is auto-covered).
const OPS_FILES = [
  resolve(repoRoot, 'Justfile'),
  resolve(repoRoot, 'docs/world-deployment-runbook.md'),
  ...(existsSync(SCRIPTS_DIR)
    ? readdirSync(SCRIPTS_DIR)
        .filter((f) => f.endsWith('.ps1') && /world|onboarding|secret|secure/i.test(f))
        .map((f) => resolve(SCRIPTS_DIR, f))
    : []),
].filter(existsSync);

// ---- Exported detector primitives -----------------------------------------------------------------

// Raw secret VALUES that must never be committed. Key Vault references and secret NAMES/REFS are OK.
export const RAW_VALUE_DENYLIST = [
  { name: 'account key', re: /AccountKey\s*=\s*[A-Za-z0-9+/=]{10,}/ },
  { name: 'shared access key', re: /SharedAccessKey\s*=\s*\S+/i },
  { name: 'SAS token', re: /(sig|SharedAccessSignature)\s*=\s*[A-Za-z0-9%+/=]{20,}/ },
  { name: 'PEM private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'cosmos/storage connection string', re: /AccountEndpoint\s*=.*AccountKey\s*=/i },
  { name: 'inline password', re: /\bpassword\s*[:=]\s*['"][^'"\s]{6,}['"]/i },
  // Raw onboarding token: only tokenHash is config. `\btoken\s*[:=]` matches `token:`/`Token =` but
  // NOT `tokenHash:` nor `..._TOKEN=` (preceded by a word char, so no `\b`).
  { name: 'raw onboarding token', re: /\btoken\s*[:=]\s*['"][^'"]+['"]/i },
];

// Unsafe secret HANDLING in deployment tooling.
export const SECRET_HANDLING_DENYLIST = [
  { name: 'non-CSPRNG Get-Random for secret material', re: /\bGet-Random\b/ },
  { name: "'keyvault secret set' passing --value (use --file)", re: /keyvault\s+secret\s+set\b[^\n]*--value\b/i },
  {
    name: 'prints a raw secret/token variable',
    re: /(Write-Host|Write-Output|Write-Information|Write-Verbose|Write-Debug|echo)\b[^\n]*\$(token|hmac|hmacSecret|secret|onboardingToken)\b/i,
  },
  { name: 'bare secret variable emitted to output', re: /^\s*\$(token|hmac|hmacSecret|secret|onboardingToken)\b\s*;?\s*$/i },
];

/** Build the `const string Name = "value";` map from CosmosContainers.cs text. */
export function parseConstMap(csText) {
  const constMap = new Map();
  for (const m of csText.matchAll(/public\s+const\s+string\s+(\w+)\s*=\s*"([^"]+)"\s*;/g)) {
    constMap.set(m[1], m[2]);
  }
  return constMap;
}

/** Parse CosmosContainers.UniqueKeyPaths into a Map(containerName -> sorted paths[]). */
export function parseCsUniqueKeys(csText) {
  const constMap = parseConstMap(csText);
  const result = new Map();
  const dictBlock = csText.match(/UniqueKeyPaths\s*=\s*new\s+Dictionary[\s\S]*?\{([\s\S]*?)\};/m);
  if (!dictBlock) return result;
  for (const entry of dictBlock[1].matchAll(/\[(\w+)\]\s*=\s*\[([^\]]*)\]/g)) {
    const containerName = constMap.get(entry[1]);
    if (!containerName) continue;
    const paths = [...entry[2].matchAll(/([A-Za-z_]\w*)/g)]
      .map((m) => constMap.get(m[1]))
      .filter((v) => v !== undefined)
      .sort();
    result.set(containerName, paths);
  }
  return result;
}

/** Parse containers.json into a Map(containerName -> sorted uniqueKeyPaths[]) for declared containers. */
export function parseJsonUniqueKeys(spec) {
  const result = new Map();
  for (const c of spec.containers) {
    if (Array.isArray(c.uniqueKeyPaths) && c.uniqueKeyPaths.length > 0) {
      result.set(c.name, [...c.uniqueKeyPaths].sort());
    }
  }
  return result;
}
export function scanContent(content, denyList) {
  const hits = [];
  content.split(/\r?\n/).forEach((line, idx) => {
    for (const { name, re } of denyList) {
      if (re.test(line)) hits.push({ name, line: idx + 1 });
    }
  });
  return hits;
}

/**
 * Classify every `provision-world-onboarding.ps1` invocation in a document, after collapsing
 * PowerShell backtick line-continuations so a multi-line call is a single unit:
 *   - managed  = has -CivVault (provisions World + civ vaults in ONE run)
 *   - external = has -RetainTransferFiles (World vault + retained files for an external civ)
 *   - worldOnly = neither (the buggy pattern: a World-only run that mints a token the civ never gets)
 * Credentials must be generated exactly once per civ, so the managed-civ flow requires exactly one
 * `managed` call and zero `worldOnly` calls.
 */
export function categorizeOnboardingInvocations(content) {
  const joined = content.replace(/`[ \t]*\r?\n[ \t]*/g, ' ');
  let managed = 0;
  let external = 0;
  let worldOnly = 0;
  for (const line of joined.split(/\r?\n/)) {
    if (!/provision-world-onboarding\.ps1/.test(line)) continue;
    if (!/-WorldVault\b/.test(line)) continue; // an actual invocation, not prose
    if (/-CivVault\b/.test(line)) managed++;
    else if (/-RetainTransferFiles\b/.test(line)) external++;
    else worldOnly++;
  }
  return { managed, external, worldOnly };
}

// ---- Runtime state --------------------------------------------------------------------------------
const rel = (p) => relative(repoRoot, p).replace(/\\/g, '/');
const errors = [];

function sortedSet(values) {
  return [...new Set(values)].sort();
}
function eqSet(a, b) {
  const sa = sortedSet(a);
  const sb = sortedSet(b);
  return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
}

// --------------------------------------------------------------------------------------------------
// (1) Container parity
// --------------------------------------------------------------------------------------------------
function checkContainerParity() {
  const spec = JSON.parse(readFileSync(CONTAINERS_JSON, 'utf8'));
  const cs = readFileSync(COSMOS_CONTAINERS_CS, 'utf8');

  const constMap = new Map();
  for (const m of cs.matchAll(/public\s+const\s+string\s+(\w+)\s*=\s*"([^"]+)"\s*;/g)) {
    constMap.set(m[1], m[2]);
  }

  const partitionKeyPath = constMap.get('PartitionKeyPath');
  if (!partitionKeyPath) {
    errors.push('parity: could not find PartitionKeyPath const in CosmosContainers.cs');
  } else if (partitionKeyPath !== spec.partitionKeyPath) {
    errors.push(
      `parity: partitionKeyPath mismatch — containers.json '${spec.partitionKeyPath}' vs C# '${partitionKeyPath}'`,
    );
  }

  const listIdentifiers = (label) => {
    const re = new RegExp(`${label}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm');
    const block = cs.match(re);
    if (!block) {
      errors.push(`parity: could not find ${label} list in CosmosContainers.cs`);
      return null;
    }
    const ids = [...block[1].matchAll(/([A-Za-z_]\w*)/g)].map((m) => m[1]);
    const resolved = [];
    for (const id of ids) {
      if (!constMap.has(id)) {
        errors.push(`parity: ${label} references unknown identifier '${id}'`);
        continue;
      }
      resolved.push(constMap.get(id));
    }
    return resolved;
  };

  const csAll = listIdentifiers('All');
  const csTtl = listIdentifiers('TtlContainers');
  const jsonAll = spec.containers.map((c) => c.name);
  const jsonTtl = spec.containers.filter((c) => c.ttl === true).map((c) => c.name);

  if (jsonAll.length !== new Set(jsonAll).size) {
    errors.push('parity: containers.json has duplicate container names');
  }
  if (csAll && !eqSet(csAll, jsonAll)) {
    errors.push(
      `parity: container set mismatch\n  C#:   ${sortedSet(csAll).join(', ')}\n  JSON: ${sortedSet(jsonAll).join(', ')}`,
    );
  }
  if (csTtl && !eqSet(csTtl, jsonTtl)) {
    errors.push(
      `parity: TTL container set mismatch\n  C#:   ${sortedSet(csTtl).join(', ')}\n  JSON: ${sortedSet(jsonTtl).join(', ')}`,
    );
  }
  if (csAll && eqSet(csAll, jsonAll) && csTtl && eqSet(csTtl, jsonTtl)) {
    console.log(
      `parity: OK — ${jsonAll.length} containers, PK '${spec.partitionKeyPath}', TTL on [${sortedSet(jsonTtl).join(', ')}]`,
    );
  }

  checkUniqueKeyParity(spec, cs, constMap);
}

// --------------------------------------------------------------------------------------------------
// (1b) Unique-key parity: containers.json `uniqueKeyPaths` MUST match CosmosContainers.UniqueKeyPaths,
// and worldEvents MUST carry exactly `/payload/worldsequence` (the structural duplicate-sequence
// backstop). main.bicep MUST emit a uniqueKeyPolicy from the declared paths.
// --------------------------------------------------------------------------------------------------
function checkUniqueKeyParity(spec, cs, constMap) {
  const jsonUnique = parseJsonUniqueKeys(spec);
  const csUnique = parseCsUniqueKeys(cs);
  if (csUnique.size === 0) {
    errors.push('unique-key: could not find UniqueKeyPaths dictionary in CosmosContainers.cs');
  }

  // Every declared container must match on both sides.
  const names = sortedSet([...jsonUnique.keys(), ...csUnique.keys()]);
  for (const name of names) {
    const j = jsonUnique.get(name);
    const c = csUnique.get(name);
    if (!j || !c || !eqSet(j, c)) {
      errors.push(
        `unique-key: unique-key path mismatch for '${name}'\n  C#:   ${(c ?? []).join(', ') || '(none)'}\n  JSON: ${(j ?? []).join(', ') || '(none)'}`,
      );
    }
  }

  // Hard requirement: worldEvents carries exactly `/payload/worldsequence`.
  const weJson = jsonUnique.get('worldEvents') ?? [];
  if (!eqSet(weJson, ['/payload/worldsequence'])) {
    errors.push(
      `unique-key: worldEvents must declare exactly ['/payload/worldsequence'] in containers.json (found [${weJson.join(', ')}])`,
    );
  }

  // main.bicep must actually emit a unique-key policy from the declared paths.
  const bicep = readFileSync(MAIN_BICEP, 'utf8');
  if (!/uniqueKeyPolicy/.test(bicep) || !/uniqueKeyPaths/.test(bicep)) {
    errors.push('unique-key: main.bicep does not emit a uniqueKeyPolicy from containers.json uniqueKeyPaths');
  }

  if (names.length > 0 && names.every((n) => eqSet(jsonUnique.get(n) ?? [], csUnique.get(n) ?? [])) && eqSet(weJson, ['/payload/worldsequence'])) {
    console.log(`unique-key: OK — worldEvents unique key '/payload/worldsequence' parity (JSON/C#/Bicep)`);
  }
}

// --------------------------------------------------------------------------------------------------
// (2) No-secret scan (infra + ops) + SecretUri enforcement + unconditional purge protection
// --------------------------------------------------------------------------------------------------
function checkNoSecrets() {
  let clean = true;

  // Raw secret values must not appear in ANY infra or ops file.
  for (const file of [...INFRA_FILES, ...OPS_FILES]) {
    for (const { name, line } of scanContent(readFileSync(file, 'utf8'), RAW_VALUE_DENYLIST)) {
      clean = false;
      errors.push(`no-secret: possible ${name} in ${rel(file)}:${line}`);
    }
  }

  // The secret map MUST be a versionless Key Vault SecretUri reference (never a raw value / VaultName=).
  for (const file of INFRA_FILES) {
    const content = readFileSync(file, 'utf8');
    if (content.includes('Secrets__Map__')) {
      if (/@Microsoft\.KeyVault\(VaultName=/.test(content)) {
        clean = false;
        errors.push(`no-secret: ${rel(file)} uses the VaultName= Key Vault reference form; use SecretUri=`);
      }
      if (!/@Microsoft\.KeyVault\(SecretUri=/.test(content)) {
        clean = false;
        errors.push(
          `no-secret: ${rel(file)} wires the Secrets map without an @Microsoft.KeyVault(SecretUri=...) reference (possible raw secret)`,
        );
      }
    }
  }

  // Every Bicep vault MUST assert unconditional purge protection.
  for (const file of INFRA_FILES.filter((f) => f.endsWith('.bicep'))) {
    const content = readFileSync(file, 'utf8');
    if (content.includes('Microsoft.KeyVault/vaults@')) {
      if (!/enablePurgeProtection:\s*true\b/.test(content)) {
        clean = false;
        errors.push(`no-secret: ${rel(file)} declares a Key Vault without unconditional \`enablePurgeProtection: true\``);
      }
    }
  }

  if (clean) {
    console.log(
      `no-secret: OK — scanned ${INFRA_FILES.length} infra + ${OPS_FILES.length} ops files; SecretUri refs + unconditional purge protection`,
    );
  }
}

// --------------------------------------------------------------------------------------------------
// (3) Onboarding record validation (parsed from main.bicepparam)
// --------------------------------------------------------------------------------------------------
function extractActiveArrayLiteral(text, paramName) {
  const lines = text.split(/\r?\n/);
  let start = -1;
  const decl = new RegExp(`^param\\s+${paramName}\\s*=`);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('//')) continue;
    if (decl.test(trimmed)) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  let buf = '';
  let depth = 0;
  let started = false;
  for (let i = start; i < lines.length; i++) {
    const codeOnly = lines[i].replace(/\/\/.*$/, '');
    buf += `${codeOnly}\n`;
    for (const ch of codeOnly) {
      if (ch === '[') {
        depth++;
        started = true;
      } else if (ch === ']') {
        depth--;
      }
    }
    if (started && depth === 0) break;
  }
  return buf;
}

function checkOnboardingRecords() {
  const text = readFileSync(BICEPPARAM, 'utf8');
  const literal = extractActiveArrayLiteral(text, 'onboardingRecords');
  if (literal === null) {
    errors.push('onboarding: could not find an active `param onboardingRecords = [...]` in main.bicepparam');
    return;
  }

  const objectBlocks = [...literal.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]);
  const records = objectBlocks.map((block) => {
    const fields = {};
    for (const fm of block.matchAll(/(\w+)\s*:\s*'([^']*)'/g)) {
      fields[fm[1]] = fm[2];
    }
    return fields;
  });

  if (records.length === 0) {
    console.log('onboarding: OK — 0 records (first-deploy shape); validation applies when records are added');
    return;
  }

  const patterns = {
    tokenHash: /^[0-9a-f]{64}$/,
    civId: /^[A-Za-z0-9_-]{1,64}$/,
    keyId: /^[A-Za-z0-9_-]{1,64}$/,
    secretRef: /^[A-Za-z0-9_-]{1,64}$/,
    secretName: /^[0-9A-Za-z-]{1,127}$/,
  };
  const uniqueness = {
    tokenHash: new Set(),
    civId: new Set(),
    keyId: new Set(),
    secretRef: new Set(),
    secretName: new Set(),
  };
  const required = Object.keys(patterns);
  let recordErrors = 0;
  const push = (msg) => {
    recordErrors++;
    errors.push(msg);
  };

  records.forEach((r, i) => {
    if (
      Object.prototype.hasOwnProperty.call(r, 'token') ||
      Object.prototype.hasOwnProperty.call(r, 'Token')
    ) {
      push(`onboarding: record[${i}] contains a raw \`token\`/\`Token\` property — only tokenHash is allowed`);
    }
    for (const field of required) {
      const val = r[field];
      if (val === undefined) {
        push(`onboarding: record[${i}] is missing '${field}'`);
        continue;
      }
      if (!patterns[field].test(val)) {
        push(`onboarding: record[${i}].${field}='${val}' fails ${patterns[field]}`);
      }
      if (uniqueness[field].has(val)) {
        push(`onboarding: duplicate ${field}='${val}' across records`);
      }
      uniqueness[field].add(val);
    }
  });

  const civIds = records.map((r) => r.civId ?? '');
  const sorted = [...civIds].sort();
  if (civIds.join('\u0000') !== sorted.join('\u0000')) {
    push(`onboarding: records must be stably sorted by civId (found [${civIds.join(', ')}])`);
  }

  if (recordErrors === 0) {
    console.log(`onboarding: OK — ${records.length} record(s), unique + well-formed + sorted by civId`);
  }
}

// --------------------------------------------------------------------------------------------------
// (4) Secret-handling hygiene in deployment tooling
// --------------------------------------------------------------------------------------------------
function checkSecretHandling() {
  let clean = true;
  for (const file of OPS_FILES) {
    for (const { name, line } of scanContent(readFileSync(file, 'utf8'), SECRET_HANDLING_DENYLIST)) {
      clean = false;
      errors.push(`secret-handling: ${name} in ${rel(file)}:${line}`);
    }
  }
  if (clean) {
    console.log(`secret-handling: OK — scanned ${OPS_FILES.length} ops files (CSPRNG, --file, no printed secrets)`);
  }
}

// --------------------------------------------------------------------------------------------------
// (5) Deploy tooling: checksum verification + readiness gate must be present
// --------------------------------------------------------------------------------------------------
function checkDeployTooling() {
  let clean = true;
  const require = (file, needles) => {
    if (!existsSync(file)) {
      clean = false;
      errors.push(`deploy-tooling: missing ${rel(file)}`);
      return;
    }
    const content = readFileSync(file, 'utf8');
    for (const { label, sub } of needles) {
      if (!content.includes(sub)) {
        clean = false;
        errors.push(`deploy-tooling: ${rel(file)} is missing ${label} ('${sub}')`);
      }
    }
  };

  // Deploy script: verify checksum before deploy AND gate on readiness, throwing on failure.
  require(DEPLOY_SCRIPT, [
    { label: 'checksum verification', sub: 'Get-FileHash' },
    { label: 'checksum mismatch throw', sub: 'Checksum MISMATCH' },
    { label: 'liveness probe', sub: '/health' },
    { label: 'readiness probe', sub: '/health/ready' },
    { label: 'readiness failure throw', sub: 'Health gate FAILED' },
    { label: 'rollback pointer', sub: 'world.prev.zip' },
  ]);

  // Package script: retain the prior artifact AND its checksum, and checksum the new one.
  require(PACKAGE_SCRIPT, [
    { label: 'prior-artifact retention', sub: 'world.prev.zip' },
    { label: 'prior-checksum retention', sub: 'world.prev.zip.sha256' },
    { label: 'checksum generation', sub: 'Get-FileHash' },
  ]);

  if (clean) {
    console.log('deploy-tooling: OK — checksum verification + readiness gate present');
  }
}

// --------------------------------------------------------------------------------------------------
// (4b) Onboarding flow: credentials generated exactly once (managed-civ) — no World-only re-run
// --------------------------------------------------------------------------------------------------
function checkOnboardingFlow() {
  const { managed, external, worldOnly } = categorizeOnboardingInvocations(readFileSync(RUNBOOK, 'utf8'));
  let ok = true;
  if (worldOnly > 0) {
    ok = false;
    errors.push(
      `onboarding-flow: runbook has ${worldOnly} World-only provision-world-onboarding call(s) (neither -CivVault nor -RetainTransferFiles) — the managed-civ flow must generate credentials ONCE with both -WorldVault and -CivVault`,
    );
  }
  if (managed !== 1) {
    ok = false;
    errors.push(
      `onboarding-flow: runbook must contain exactly ONE managed-civ helper call (-WorldVault + -CivVault), found ${managed}`,
    );
  }
  if (ok) {
    console.log(
      `onboarding-flow: OK — 1 managed-civ call, ${external} external-civ call(s), 0 World-only calls`,
    );
  }
}

function runAll() {
  checkContainerParity();
  checkNoSecrets();
  checkOnboardingRecords();
  checkOnboardingFlow();
  checkSecretHandling();
  checkDeployTooling();

  if (errors.length > 0) {
    console.error('\nWorld infra checks FAILED:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log('\nAll World infra checks passed.');
}

// Only run when executed directly, so the self-test can import the detectors.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAll();
}
