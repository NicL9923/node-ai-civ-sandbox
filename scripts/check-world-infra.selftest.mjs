#!/usr/bin/env node
// =====================================================================================================
// check-world-infra.selftest.mjs — negative-fixture regression tests for the World infra guard's
// detector primitives. Asserts each denylist actually catches adversarial content (raw token / HMAC /
// PEM / account key / SAS / connection string / inline password; Get-Random / `--value` / printed +
// bare secret variables) AND does not false-positive on the safe placeholders the runbook/params use
// (tokenHash, `WORLD_ONBOARDING_TOKEN=`, `$rawToken` assignments).
//
// Exit 0 = all assertions hold; 1 = a detector regressed.
// =====================================================================================================

import { RAW_VALUE_DENYLIST, SECRET_HANDLING_DENYLIST, scanContent, categorizeOnboardingInvocations, parseCsUniqueKeys, parseJsonUniqueKeys } from './check-world-infra.mjs';

const failures = [];
const hitNames = (content, denyList) => scanContent(content, denyList).map((h) => h.name);

function expectHit(label, content, denyList, expectedName) {
  const names = hitNames(content, denyList);
  if (!names.includes(expectedName)) {
    failures.push(`EXPECTED to catch [${expectedName}] in ${label}, but got [${names.join(', ') || 'none'}]`);
  }
}
function expectClean(label, content, denyList) {
  const names = hitNames(content, denyList);
  if (names.length > 0) {
    failures.push(`EXPECTED clean for ${label}, but caught [${names.join(', ')}]`);
  }
}

// --- Raw secret VALUES that must be caught ---
expectHit('raw onboarding token', "token: 'deadbeefdeadbeef'", RAW_VALUE_DENYLIST, 'raw onboarding token');
expectHit('raw onboarding token (assign)', "Token = 'deadbeef'", RAW_VALUE_DENYLIST, 'raw onboarding token');
expectHit(
  'PEM private key',
  '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----',
  RAW_VALUE_DENYLIST,
  'PEM private key',
);
expectHit('account key', 'AccountKey=Zm9vYmFyMTIzNDU2Nzg5MA==', RAW_VALUE_DENYLIST, 'account key');
expectHit(
  'cosmos connection string',
  'AccountEndpoint=https://x.documents.azure.com:443/;AccountKey=abc123def456==;',
  RAW_VALUE_DENYLIST,
  'cosmos/storage connection string',
);
expectHit('SAS token', 'https://x.blob.core.windows.net/c?sig=aB3dEf6HiJkLmNoPqRsTuVwXyZ0123456789%2B', RAW_VALUE_DENYLIST, 'SAS token');
expectHit('inline password', "password: 'hunter2secret'", RAW_VALUE_DENYLIST, 'inline password');

// --- Raw-value FALSE-POSITIVE guards (these must stay clean) ---
expectClean("tokenHash config", "tokenHash: 'a1b2c3'", RAW_VALUE_DENYLIST);
expectClean('env var name WORLD_ONBOARDING_TOKEN', 'WORLD_ONBOARDING_TOKEN="@Microsoft.KeyVault(SecretUri=https://v/secrets/x/)"', RAW_VALUE_DENYLIST);
expectClean('CSPRNG token assignment', '$onboardingToken = [Convert]::ToHexString($b).ToLower()', RAW_VALUE_DENYLIST);
expectClean('SecretUri reference', "value: '@Microsoft.KeyVault(SecretUri=https://v.vault.azure.net/secrets/n/)'", RAW_VALUE_DENYLIST);

// --- Unsafe secret HANDLING that must be caught ---
expectHit('Get-Random', '$t = Get-Random -Maximum 256', SECRET_HANDLING_DENYLIST, 'non-CSPRNG Get-Random for secret material');
expectHit(
  'keyvault secret set --value',
  'az keyvault secret set --vault-name v --name n --value $hmac',
  SECRET_HANDLING_DENYLIST,
  "'keyvault secret set' passing --value (use --file)",
);
expectHit('printed token', 'Write-Host "token is $onboardingToken"', SECRET_HANDLING_DENYLIST, 'prints a raw secret/token variable');
expectHit('printed hmac via verbose', 'Write-Verbose $hmacSecret', SECRET_HANDLING_DENYLIST, 'prints a raw secret/token variable');
expectHit('bare secret var', '  $hmacSecret', SECRET_HANDLING_DENYLIST, 'bare secret variable emitted to output');

// --- Secret-handling FALSE-POSITIVE guards ---
expectClean('printed tokenHash (non-secret)', 'Write-Host "tokenHash: $tokenHash"', SECRET_HANDLING_DENYLIST);
expectClean('keyvault secret set --file', 'az keyvault secret set --vault-name v --name n --file $f', SECRET_HANDLING_DENYLIST);
expectClean('CSPRNG RandomNumberGenerator', '$rng = [System.Security.Cryptography.RandomNumberGenerator]', SECRET_HANDLING_DENYLIST);

// --- Onboarding-flow categorization (single-generation invariant) ---
function expectCounts(label, content, expected) {
  const got = categorizeOnboardingInvocations(content);
  for (const k of ['managed', 'external', 'worldOnly']) {
    if (got[k] !== expected[k]) {
      failures.push(`flow ${label}: expected ${k}=${expected[k]}, got ${got[k]}`);
    }
  }
}
// Correct managed flow: one call with both vaults (across backtick-continued lines) + one external.
expectCounts(
  'managed + external',
  "$r = ./scripts/provision-world-onboarding.ps1 -WorldVault w `\n  -HmacSecretName h -CivVault c -Subscription s\n" +
    '$r = ./scripts/provision-world-onboarding.ps1 -WorldVault w -RetainTransferFiles -Subscription s',
  { managed: 1, external: 1, worldOnly: 0 },
);
// The bug pattern: a World-only run (neither -CivVault nor -RetainTransferFiles).
expectCounts(
  'world-only bug',
  '$r = ./scripts/provision-world-onboarding.ps1 -WorldVault w -HmacSecretName h -Subscription s',
  { managed: 0, external: 0, worldOnly: 1 },
);
// Two managed runs (would mint mismatched credentials).
expectCounts(
  'two managed',
  './scripts/provision-world-onboarding.ps1 -WorldVault w -CivVault c\n' +
    './scripts/provision-world-onboarding.ps1 -WorldVault w -CivVault c2',
  { managed: 2, external: 0, worldOnly: 0 },
);
// Prose mention (no -WorldVault) must not count.
expectCounts('prose mention', 'See scripts/provision-world-onboarding.ps1 for details.', { managed: 0, external: 0, worldOnly: 0 });

// --- Unique-key parity parsers (worldEvents /payload/worldsequence backstop) ---
const CS_SAMPLE = `
  public const string WorldEvents = "worldEvents";
  public const string WorldEventSequencePath = "/payload/worldsequence";
  public static readonly IReadOnlyDictionary<string, IReadOnlyList<string>> UniqueKeyPaths =
      new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal)
      {
          [WorldEvents] = [WorldEventSequencePath],
      };
`;
function expectUniqueKey(label, map, name, expected) {
  const got = map.get(name);
  const eq = Array.isArray(got) && got.length === expected.length && got.every((v, i) => v === expected[i]);
  if (!eq) {
    failures.push(`unique-key ${label}: expected ${name}=[${expected.join(', ')}], got [${(got ?? []).join(', ') || 'none'}]`);
  }
}
expectUniqueKey('C# parse', parseCsUniqueKeys(CS_SAMPLE), 'worldEvents', ['/payload/worldsequence']);
expectUniqueKey(
  'JSON parse',
  parseJsonUniqueKeys({ containers: [{ name: 'worldEvents', ttl: false, uniqueKeyPaths: ['/payload/worldsequence'] }, { name: 'lock', ttl: false }] }),
  'worldEvents',
  ['/payload/worldsequence'],
);
// A mismatch (JSON declares the wrong path) must be detectable by comparing the two maps.
{
  const csMap = parseCsUniqueKeys(CS_SAMPLE);
  const jsonMap = parseJsonUniqueKeys({ containers: [{ name: 'worldEvents', uniqueKeyPaths: ['/payload/wrong'] }] });
  const same = JSON.stringify(csMap.get('worldEvents')) === JSON.stringify(jsonMap.get('worldEvents'));
  if (same) {
    failures.push('unique-key mismatch: parser failed to distinguish /payload/worldsequence from /payload/wrong');
  }
}
// A dropped C# dictionary must yield an empty map (guard then reports it missing).
if (parseCsUniqueKeys('// no dictionary here').size !== 0) {
  failures.push('unique-key: parseCsUniqueKeys should return empty when the dictionary is absent');
}

if (failures.length > 0) {
  console.error('World infra guard SELF-TEST FAILED:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`World infra guard self-test passed (raw-value + secret-handling + unique-key parity detectors verified).`);
