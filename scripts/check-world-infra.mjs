#!/usr/bin/env node
// =====================================================================================================
// check-world-infra.mjs — zero-dependency IaC guardrails for the World deployment.
//
//   (1) Container parity: infra/world/containers.json MUST match the runtime contract in
//       WorldMap.Infrastructure.Cosmos.CosmosContainers (`All`, `TtlContainers`, `PartitionKeyPath`),
//       so the Bicep-provisioned schema can't drift from what CosmosReadinessProbe validates.
//   (2) No-secret scan: World Bicep/param/json files MUST NOT contain raw secret VALUES; the secret
//       map MUST be wired via a versionless Key Vault SecretUri reference; purge protection MUST be
//       unconditional (no param, never false).
//   (3) Onboarding records: statically validate shape/format/uniqueness/ordering of onboardingRecords.
//   (4) Secret-handling hygiene: deployment tooling (Justfile, runbook) MUST NOT use a non-CSPRNG
//       generator, pass secrets as CLI --value args, or print raw token/HMAC/secret variables.
//
// Exit code 0 = all checks pass; 1 = a check failed.
// =====================================================================================================

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

const WORLD_INFRA_DIR = resolve(repoRoot, 'infra/world');
const CONTAINERS_JSON = resolve(WORLD_INFRA_DIR, 'containers.json');
const BICEPPARAM = resolve(WORLD_INFRA_DIR, 'main.bicepparam');
const MAIN_BICEP = resolve(WORLD_INFRA_DIR, 'main.bicep');
const COSMOS_CONTAINERS_CS = resolve(
  repoRoot,
  'apps/world-map/src/WorldMap.Infrastructure/Cosmos/CosmosContainers.cs',
);

// Scan EVERY hand-authored file in infra/world (not a fixed list) so a secret in a new file is covered.
const SCAN_FILES = readdirSync(WORLD_INFRA_DIR)
  .filter((f) => /\.(bicep|bicepparam|json)$/.test(f))
  .map((f) => resolve(WORLD_INFRA_DIR, f));

// Deployment tooling that handles secrets/tokens operationally.
const OPS_FILES = [
  resolve(repoRoot, 'Justfile'),
  resolve(repoRoot, 'docs/world-deployment-runbook.md'),
].filter(existsSync);

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
}

// --------------------------------------------------------------------------------------------------
// (2) No-secret scan + SecretUri enforcement + unconditional purge protection
// --------------------------------------------------------------------------------------------------
function checkNoSecrets() {
  const denyList = [
    { name: 'account key', re: /AccountKey\s*=\s*[A-Za-z0-9+/=]{10,}/ },
    { name: 'shared access key', re: /SharedAccessKey\s*=\s*\S+/i },
    { name: 'SAS token', re: /(sig|SharedAccessSignature)\s*=\s*[A-Za-z0-9%+/=]{20,}/ },
    { name: 'PEM private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    { name: 'cosmos/storage connection string', re: /AccountEndpoint\s*=.*AccountKey\s*=/i },
    { name: 'inline password', re: /\bpassword\s*[:=]\s*['"][^'"\s]{6,}['"]/i },
    // Raw onboarding token: only tokenHash is config. `\btoken\s*[:=]` matches `token:`/`Token =`
    // but NOT `tokenHash:`/`TokenHash:`.
    { name: 'raw onboarding token', re: /\btoken\s*[:=]\s*['"][^'"]+['"]/i },
    // Purge protection must be unconditional: no parameter and never a false value.
    { name: 're-introduced purge-protection parameter', re: /\bparam\s+enablePurgeProtection\b/ },
    { name: 'purge protection disabled', re: /enablePurgeProtection\s*[:=]\s*false\b/i },
  ];

  let clean = true;
  for (const file of SCAN_FILES) {
    const content = readFileSync(file, 'utf8');
    content.split(/\r?\n/).forEach((line, idx) => {
      for (const { name, re } of denyList) {
        if (re.test(line)) {
          clean = false;
          errors.push(`no-secret: possible ${name} in ${rel(file)}:${idx + 1}`);
        }
      }
    });

    // The secret map MUST be a versionless Key Vault SecretUri reference — never a raw value and
    // never the VaultName=;SecretName= form (which the security baseline rejects).
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

  // main.bicep must positively assert unconditional purge protection.
  const mainBicep = readFileSync(MAIN_BICEP, 'utf8');
  if (!/enablePurgeProtection:\s*true\b/.test(mainBicep)) {
    clean = false;
    errors.push('no-secret: main.bicep must set Key Vault `enablePurgeProtection: true` unconditionally');
  }

  if (clean) {
    console.log(
      `no-secret: OK — scanned ${SCAN_FILES.length} files; SecretUri refs + unconditional purge protection`,
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
    if (trimmed.startsWith('//')) continue; // skip commented example
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

  // Each { ... } object block inside the array (records have no nested braces).
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
    tokenHash: /^[0-9a-f]{64}$/, // lowercase 64-hex SHA-256
    civId: /^[A-Za-z0-9_-]{1,64}$/,
    keyId: /^[A-Za-z0-9_-]{1,64}$/,
    secretRef: /^[A-Za-z0-9_-]{1,64}$/, // safe .NET env dictionary key
    secretName: /^[0-9A-Za-z-]{1,127}$/, // valid Key Vault secret name
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
// (4) Secret-handling hygiene in deployment tooling (Justfile + runbook)
// --------------------------------------------------------------------------------------------------
function checkSecretHandling() {
  const denyList = [
    { name: 'non-CSPRNG Get-Random for secret material', re: /\bGet-Random\b/ },
    // `az keyvault secret set --value ...` exposes the secret in process args/shell history; use --file.
    { name: "'keyvault secret set' passing --value (use --file)", re: /keyvault\s+secret\s+set\b[^\n]*--value\b/i },
    // Printing a raw token/HMAC/secret variable. The trailing `\b` means `$token` matches but
    // `$tokenHash` (a non-secret hash) does not.
    {
      name: 'prints a raw secret/token variable',
      re: /(Write-Host|Write-Output|Write-Information|echo)\b[^\n]*\$(token|hmac|hmacSecret|secret|onboardingToken)\b/i,
    },
  ];

  let clean = true;
  for (const file of OPS_FILES) {
    const content = readFileSync(file, 'utf8');
    content.split(/\r?\n/).forEach((line, idx) => {
      for (const { name, re } of denyList) {
        if (re.test(line)) {
          clean = false;
          errors.push(`secret-handling: ${name} in ${rel(file)}:${idx + 1}`);
        }
      }
    });
  }

  if (clean) {
    console.log(`secret-handling: OK — scanned ${OPS_FILES.length} ops files (CSPRNG, --file, no printed secrets)`);
  }
}

checkContainerParity();
checkNoSecrets();
checkOnboardingRecords();
checkSecretHandling();

if (errors.length > 0) {
  console.error('\nWorld infra checks FAILED:');
  for (const e of errors) {
    console.error(`  - ${e}`);
  }
  process.exit(1);
}

console.log('\nAll World infra checks passed.');
