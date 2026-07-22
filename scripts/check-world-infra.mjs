#!/usr/bin/env node
// =====================================================================================================
// check-world-infra.mjs — zero-dependency IaC guardrails for the World deployment.
//
//   (1) Container parity: infra/world/containers.json MUST match the runtime contract in
//       WorldMap.Infrastructure.Cosmos.CosmosContainers (the `All` list, `TtlContainers`, and
//       `PartitionKeyPath`). This prevents the Bicep-provisioned schema from drifting away from what
//       CosmosReadinessProbe validates at /health/ready.
//
//   (2) No-secret scan: the World Bicep templates + param file MUST NOT contain raw secret values
//       (account keys, SAS, PEM keys, connection strings). Key Vault references are allowed.
//
// Exit code 0 = all checks pass; 1 = a check failed (drift or a secret was found).
// =====================================================================================================

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

const WORLD_INFRA_DIR = resolve(repoRoot, 'infra/world');
const CONTAINERS_JSON = resolve(WORLD_INFRA_DIR, 'containers.json');
const COSMOS_CONTAINERS_CS = resolve(
  repoRoot,
  'apps/world-map/src/WorldMap.Infrastructure/Cosmos/CosmosContainers.cs',
);

// Scan EVERY hand-authored file in infra/world (not a fixed list) so a secret added to a new
// bicep/param/json file is still covered.
const SCAN_FILES = readdirSync(WORLD_INFRA_DIR)
  .filter((f) => /\.(bicep|bicepparam|json)$/.test(f))
  .map((f) => resolve(WORLD_INFRA_DIR, f));

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

  // Map C# const identifiers -> string values, e.g. `public const string Nonces = "nonces";`.
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

  // Extract identifier lists from `All = [ ... ];` and `TtlContainers = [ ... ];`.
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

  // Guard against accidental duplicate names in the JSON.
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
// (2) No-secret scan
// --------------------------------------------------------------------------------------------------
function checkNoSecrets() {
  // Patterns that indicate a real secret VALUE was committed. Key Vault references
  // (@Microsoft.KeyVault(...)) and secret NAMES/REFS (secretRef, secretName) are intentionally allowed.
  const denyList = [
    { name: 'account key', re: /AccountKey\s*=\s*[A-Za-z0-9+/=]{10,}/ },
    { name: 'shared access key', re: /SharedAccessKey\s*=\s*\S+/i },
    { name: 'SAS token', re: /(sig|SharedAccessSignature)\s*=\s*[A-Za-z0-9%+/=]{20,}/ },
    { name: 'PEM private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    { name: 'cosmos/storage connection string', re: /AccountEndpoint\s*=.*AccountKey\s*=/i },
    { name: 'inline password', re: /\bpassword\s*[:=]\s*['"][^'"\s]{6,}['"]/i },
    // A raw onboarding token must never be committed — only its hash (tokenHash) is config. The
    // `\btoken\s*[:=]` boundary matches `token:`/`Token =` but NOT `tokenHash:`/`TokenHash:`.
    { name: 'raw onboarding token', re: /\btoken\s*[:=]\s*['"][^'"]+['"]/i },
  ];

  let clean = true;
  for (const file of SCAN_FILES) {
    const content = readFileSync(file, 'utf8');
    const lines = content.split(/\r?\n/);
    lines.forEach((line, idx) => {
      for (const { name, re } of denyList) {
        if (re.test(line)) {
          clean = false;
          errors.push(`no-secret: possible ${name} in ${file}:${idx + 1}`);
        }
      }
    });

    // Any file that wires the secret map MUST do so via a Key Vault reference — a raw HMAC value is
    // format-indistinguishable from an allowed ref, so assert the KV-reference marker is present.
    if (content.includes('Secrets__Map__') && !content.includes('@Microsoft.KeyVault(')) {
      clean = false;
      errors.push(
        `no-secret: ${file} sets WorldMap Secrets map without a @Microsoft.KeyVault(...) reference (possible raw secret)`,
      );
    }
  }

  if (clean) {
    console.log(`no-secret: OK — scanned ${SCAN_FILES.length} files, no secret values found`);
  }
}

checkContainerParity();
checkNoSecrets();

if (errors.length > 0) {
  console.error('\nWorld infra checks FAILED:');
  for (const e of errors) {
    console.error(`  - ${e}`);
  }
  process.exit(1);
}

console.log('\nAll World infra checks passed.');
