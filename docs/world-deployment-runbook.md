# World deployment runbook

Provision and operate a production **World Map** deployment (`apps/world-map`) on Azure. The World is
a .NET 10 ASP.NET Core federation service with a bundled React observer SPA, backed by Cosmos DB
(managed-identity auth, no keys) and a single-writer lease (**scale = 1**).

> This runbook performs real Azure changes. Run it only against a subscription you own and after a
> `what-if`. The `infra/world` Bicep is idempotent and never recreates or modifies civilization
> resources. CI validates the templates but never logs in or deploys.

Templates & tooling:

- `infra/world/main.bicep` — plan + Web App + App Insights + Key Vault + Cosmos `worldmap` DB/containers + RBAC.
- `infra/world/containers.json` — Cosmos container / PK / TTL source of truth (lockstep with the runtime).
- `infra/world/civ-federation-container.bicep` — additive `federation` container for the existing civ DB.
- `infra/world/main.bicepparam` — example parameters (no secrets).
- `scripts/check-world-infra.mjs` — parity + no-secret + onboarding-record + secret-handling guard (`npm run check:world-infra`).
- `Justfile` — `world-infra-*`, `world-publish`, `world-package`, `world-deploy-app`, `world-provision-secret`, `civ-*` recipes.

## 0. Known sandbox environment

| Item | Value |
| --- | --- |
| Subscription (Test Sub) | `bce49949-4505-4c57-9207-a84ce0f5c935` |
| Tenant | `bb34272d-0432-4e5e-9f0f-e7aca4a450a8` |
| Resource group | `nicolas-node-ai-sandbox` (West US 2) |
| Existing Cosmos account (reused) | `nicnodeai0706162325` |
| Existing civ database | `sandbox` |
| Existing civ Web App | `nic-node-ai-0706162325` |

The existing **Log Analytics workspace resource ID** is not yet inventoried — supply it via
`existingLogAnalyticsWorkspaceResourceId` to reuse it, or leave blank to create a dedicated World
workspace.

## 1. Prerequisites & auth

```powershell
az login --tenant bb34272d-0432-4e5e-9f0f-e7aca4a450a8
az account set --subscription bce49949-4505-4c57-9207-a84ce0f5c935
az account show --output table

# Confirm .NET 10 is offered on Linux App Service (the linuxFxVersion default is DOTNETCORE|10.0):
az webapp list-runtimes --os linux | Select-String DOTNETCORE
```

If `DOTNETCORE|10.0` is not listed in the target region, set the `linuxFxVersion` parameter to a
supported value, or switch to a self-contained/container deployment.

Inventory existing resources (also recovers the Log Analytics workspace ID):

```powershell
az resource list --resource-group nicolas-node-ai-sandbox --output table
az monitor log-analytics workspace list --resource-group nicolas-node-ai-sandbox --query "[].id" --output tsv
```

## 2. Inventory the Cosmos account BEFORE choosing a throughput mode

`cosmosThroughputMode` is **not** a safe default — it must match the reused account's capabilities.
Inventory first, then choose:

```powershell
# Account capabilities + kind. If capabilities contains EnableServerless -> the account is serverless.
az cosmosdb show --name nicnodeai0706162325 --resource-group nicolas-node-ai-sandbox `
  --query "{kind:kind, capabilities:capabilities[].name}" -o json

# Current provisioned throughput on the existing civ database (fails if the account is serverless):
az cosmosdb sql database throughput show --account-name nicnodeai0706162325 `
  --resource-group nicolas-node-ai-sandbox --name sandbox -o json 2>$null
```

Decision:

- **`EnableServerless` present** ⇒ set `cosmosThroughputMode=serverless`. The `worldmap` database is
  created with no `options` block (serverless accounts reject throughput). Autoscale/manual will FAIL
  at deploy time.
- **No serverless capability (provisioned account)** ⇒ choose `autoscale` (DB-level shared, default
  max 1000 RU/s) or `manual`. Confirm the account's total provisioned RU/s headroom before adding a
  shared-throughput database; adjust `cosmosAutoscaleMaxThroughput`/`cosmosManualThroughput` to what
  the account budget allows.

Record the exact choice and reasoning in the change ticket. The `main.bicepparam` default
(`autoscale`, 1000 RU/s) is only an example — the deployment checklist **requires** an explicit
override after this inventory.

## 3. Edit parameters

Edit `infra/world/main.bicepparam`. Set at least:

- `existingCosmosAccountName` (default `nicnodeai0706162325`).
- `cosmosThroughputMode` (+ RU/s) per the step-2 inventory.
- `existingLogAnalyticsWorkspaceResourceId` — the ID from step 1 (or leave blank to create a new one).
- Optionally `worldAppName`, `keyVaultName`, `appServiceSkuName`/`Tier`.

Leave `onboardingRecords = []` for the first deploy (Key Vault references only resolve after their
secrets exist — see step 6). Validate locally (no login):

```powershell
just world-infra-build      # compiles all templates + validates the .bicepparam
just world-infra-check      # parity + no-secret + onboarding-record + secret-handling guards
```

## 4. Preview (what-if)

```powershell
just world-infra-whatif bce49949-4505-4c57-9207-a84ce0f5c935 nicolas-node-ai-sandbox
```

Confirm it creates only World resources (plan, site, App Insights, Key Vault, `worldmap` DB + 11
containers, 2 role assignments) and shows **no changes** to civilization resources.

## 5. Provision infrastructure (first pass, no onboarding records)

The first deploy has `onboardingRecords = []`, so **no** `WorldMap__Secrets__Map__*` settings are
created and there are **no** unresolved Key Vault references — the app comes up cleanly on an empty
onboarding set.

```powershell
just world-infra-deploy bce49949-4505-4c57-9207-a84ce0f5c935 nicolas-node-ai-sandbox
```

Idempotent. Capture the outputs (`worldAppName`, `worldAppUrl`, `worldBaseUrl`, `keyVaultName`,
`keyVaultUri`, `cosmosEndpoint`, `worldPrincipalId`).

## 6. Securely generate & store onboarding tokens + HMAC secrets

Secrets are provisioned **out-of-band** — never in Bicep, app settings, source, CLI value arguments,
or console output. Use a CSPRNG, write material only to a restricted-ACL temp directory, provision to
Key Vault from a **file** (never `--value`), and securely delete the temp directory afterward.

```powershell
# --- CSPRNG generation (use RandomNumberGenerator; never a non-cryptographic PRNG for secrets) ---
$rng = [System.Security.Cryptography.RandomNumberGenerator]
$tokBytes = [byte[]]::new(32); $rng::Fill($tokBytes)
$onboardingToken = [Convert]::ToHexString($tokBytes).ToLower()   # raw one-time token (secret)
$tokenHash = [Convert]::ToHexString(
  [System.Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($onboardingToken))
).ToLower()                                                       # SHA-256 hash (non-secret config)
$hmacBytes = [byte[]]::new(48); $rng::Fill($hmacBytes)
$hmacSecret = [Convert]::ToHexString($hmacBytes).ToLower()        # shared HMAC secret

# --- Restricted temp dir (remove inheritance; grant only the current user) ---
$secureDir = Join-Path $env:TEMP ("world-secrets-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $secureDir | Out-Null
icacls $secureDir /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null
try {
  # Store the HMAC secret to a file and provision it to the WORLD vault via --file (no value on the CLI).
  $hmacFile = Join-Path $secureDir 'aurora-hmac-v1.txt'
  Set-Content -Path $hmacFile -Value $hmacSecret -NoNewline
  just world-provision-secret <worldKeyVaultName> aurora-hmac-v1 $hmacFile

  # The civ operator needs the raw onboarding token + the same HMAC secret out-of-band. Write them to
  # the restricted dir and transfer them over an approved secure channel by OPENING these files —
  # do NOT echo them to the console or any log.
  Set-Content -Path (Join-Path $secureDir 'onboarding-token.txt') -Value $onboardingToken -NoNewline

  # Only the non-secret hash is safe to print (needed for onboardingRecords):
  Write-Host "tokenHash (non-secret): $tokenHash"
}
finally {
  # Securely delete the temp material once transferred. (In an interactive session, run this AFTER the
  # operator has copied onboarding-token.txt via the secure channel.)
  Remove-Item $secureDir -Recurse -Force -ErrorAction SilentlyContinue
}
```

> Cross-platform alternative: `openssl rand -hex 32` (token) / `openssl rand -hex 48` (HMAC) are also
> CSPRNG-backed. Never reuse a token, and never place a raw token/secret in a param file, app setting,
> deployment parameter, or process argument.

## 7. Wire onboarding records & re-deploy (deterministic)

Populate `onboardingRecords` in `main.bicepparam` with the **non-secret** binding, **stably sorted by
`civId`** (the guard enforces this — records map to `WorldMap__Onboarding__Records__<i>__*`, so a
stable order avoids index churn across deploys):

```bicep
param onboardingRecords = [
  {
    tokenHash: '<from step 6>'   // lowercase 64-hex SHA-256
    civId: 'civ_aurora'
    keyId: 'key_01'
    secretRef: 'aurora-hmac-v1'  // [A-Za-z0-9_-]{1,64}
    secretName: 'aurora-hmac-v1' // Key Vault secret name [0-9A-Za-z-]{1,127}
  }
]
```

Re-deploy. App settings are declarative in ARM, so the deployment **replaces** the full app-setting
set: adding/removing/reordering records deterministically updates `Records__<i>__*` and
`Secrets__Map__*`. The referenced Key Vault secret **must already exist** (step 6) so the SecretUri
reference resolves.

```powershell
just world-infra-check      # validates the records (format, uniqueness, sort order)
just world-infra-deploy bce49949-4505-4c57-9207-a84ce0f5c935 nicolas-node-ai-sandbox
az webapp restart --subscription bce49949-4505-4c57-9207-a84ce0f5c935 `
  --resource-group nicolas-node-ai-sandbox --name <worldAppName>
```

Verify every Key Vault reference resolved before relying on federation:

```powershell
az webapp config appsettings list --subscription bce49949-4505-4c57-9207-a84ce0f5c935 `
  --resource-group nicolas-node-ai-sandbox --name <worldAppName> `
  --query "[?starts_with(name,'WorldMap__Secrets__Map__')].name" -o tsv
# In the portal Configuration blade, each of these shows a green 'Key Vault Reference' resolved status.
```

> **Readiness limitation (honest note).** `/health/ready` validates the Cosmos schema + the
> single-writer lease, but **not** Key Vault reference resolution. An unresolved reference does not
> fail readiness; it surfaces as a failed HMAC handshake for that civ. Always confirm resolution with
> the command above (or the portal status) before enabling a civ. Extending the runtime readiness
> probe to also assert configured `secretRef`s resolve is a recommended follow-up in the World runtime
> (outside this infra change).

## 8. Publish, package (checksummed), & deploy the app

`dotnet publish` builds + bundles the observer SPA (fail-closed) into `wwwroot`. `world-package`
zips + checksums the output and preserves the previous ZIP for rollback. `world-deploy-app` deploys
and then verifies `/health` + `/health/ready`.

```powershell
just world-publish
just world-package          # -> ./publish/world.zip (+ .sha256); prior zip kept as world.prev.zip
just world-deploy-app bce49949-4505-4c57-9207-a84ce0f5c935 nicolas-node-ai-sandbox <worldAppName>
```

## 9. Verify

```powershell
$base = "https://<worldAppName>.azurewebsites.net"
curl.exe -s $base/health                       # {"status":"healthy"}  (liveness)
curl.exe -s -o /dev/null -w "%{http_code}" $base/health/ready   # 200 once schema + lease are satisfied
curl.exe -s "$base/world/v1/civilizations"     # JSON envelope {"items":[...]}
curl.exe -s -H "Accept: text/html" $base/some/deep/link | Select-String "assets/index"  # SPA shell
```

Checklist:

- **Schema** — `/health/ready` returns 200. A non-200 body names the failing check (missing container,
  wrong PK, missing/destructive TTL, or lease not held). `BootstrapEnabled=false` in production; the
  Bicep provisions the schema and readiness only validates it.
- **Single-writer lease** — with exactly one instance the lease is held. Never scale past 1: a second
  instance fails readiness by design.
- **SPA** — root + deep links serve the hashed SPA index; unknown API routes return 404, not HTML.
- **Telemetry** — traces/metrics appear in the World Application Insights (`<worldAppName>-insights`)
  via the OpenTelemetry Azure Monitor exporter.

## 10. Enable the civilization → World connector (phase 2)

The P3 connector is off until `WORLD_API_BASE_URL` is set on the existing civ app.

1. Ensure the additive `federation` container exists in the civ `sandbox` DB (idempotent):

   ```powershell
   just world-federation-container bce49949-4505-4c57-9207-a84ce0f5c935 nicolas-node-ai-sandbox
   ```

2. **Store the civ's secrets with least privilege.** Put the civ's HMAC secret + onboarding token in
   a Key Vault the civ MI can read, then grant the civ MI **secret-scoped** access — NOT vault-level
   access to the World vault (which would expose other civs' secrets):

   ```powershell
   $sub = "bce49949-4505-4c57-9207-a84ce0f5c935"; $rg = "nicolas-node-ai-sandbox"
   $civMi = az webapp identity show --subscription $sub --resource-group $rg `
     --name nic-node-ai-0706162325 --query principalId -o tsv

   # Secret-resource scope = <vault resource id>/secrets/<secretName>. Prefer a SEPARATE civ vault.
   $civVault = "<civKeyVaultName>"
   $secretScope = "/subscriptions/$sub/resourceGroups/$rg/providers/Microsoft.KeyVault/vaults/$civVault/secrets/civ-aurora-hmac-v1"
   az role assignment create --assignee-object-id $civMi --assignee-principal-type ServicePrincipal `
     --role "Key Vault Secrets User" --scope $secretScope

   # Verify the secret-scoped assignment was accepted:
   az role assignment list --assignee $civMi --scope $secretScope -o table
   ```

   **If secret-level scope is rejected**, STOP and use a **separate civ vault** with a vault-level
   `Key Vault Secrets User` assignment on that civ vault only. Do **not** broaden the civ MI to the
   World vault. The World MI retains vault-level access to the **World** vault only.

3. Set the civ app's `WORLD_*` settings as Key Vault references (secrets), then flip
   `WORLD_API_BASE_URL` **last** so federation only turns on once the credentials resolve:

   | Setting | Value |
   | --- | --- |
   | `WORLD_HMAC_SECRET` | `@Microsoft.KeyVault(SecretUri=https://<civVault>.vault.azure.net/secrets/civ-aurora-hmac-v1/)` |
   | `WORLD_ONBOARDING_TOKEN` *or* `WORLD_CIV_ID`+`WORLD_KEY_ID` | KV reference / provisioned pair |
   | `WORLD_DISPLAY_NAME` | optional display name |
   | `WORLD_API_BASE_URL` | the World `worldBaseUrl` output (set last) |

   ```powershell
   just civ-enable-federation $sub $rg nic-node-ai-0706162325 "https://<worldAppName>.azurewebsites.net/world/v1"
   ```

4. Drive the connector via the civ admin API (behind `ADMIN_API_KEY`):

   ```powershell
   $civ = "https://nic-node-ai-0706162325.azurewebsites.net"
   $h = @{ "x-admin-api-key" = "<ADMIN_API_KEY>" }
   Invoke-RestMethod -Method Post -Uri "$civ/api/admin/federation/register"  -Headers $h
   Invoke-RestMethod -Method Post -Uri "$civ/api/admin/federation/heartbeat" -Headers $h
   Invoke-RestMethod -Method Post -Uri "$civ/api/admin/federation/sync"      -Headers $h
   Invoke-RestMethod -Method Get  -Uri "$civ/api/admin/federation/status"    -Headers $h
   ```

## 11. Rollback

- **Disable civ federation (kill switch):**

  ```powershell
  just civ-rollback-federation bce49949-4505-4c57-9207-a84ce0f5c935 nicolas-node-ai-sandbox nic-node-ai-0706162325
  ```

  Removing `WORLD_API_BASE_URL` + restart disables the connector; the `federation` container and civ
  state are left intact.

- **World app:** redeploy the retained previous artifact — `./publish/world.prev.zip` (checksum in
  `./publish/world.zip.sha256`) — via `az webapp deploy --type zip --src-path ./publish/world.prev.zip`.
- **World infra:** the templates are idempotent; re-deploy a known-good `main.bicepparam`. The
  `worldmap` database + durable containers persist independently of the app.

## Portal deep links

- World app: `https://portal.azure.com/#@bb34272d-0432-4e5e-9f0f-e7aca4a450a8/resource/subscriptions/bce49949-4505-4c57-9207-a84ce0f5c935/resourceGroups/nicolas-node-ai-sandbox/providers/Microsoft.Web/sites/<worldAppName>`
- Resource group: `https://portal.azure.com/#@bb34272d-0432-4e5e-9f0f-e7aca4a450a8/resource/subscriptions/bce49949-4505-4c57-9207-a84ce0f5c935/resourceGroups/nicolas-node-ai-sandbox/overview`

## Raw deploy commands (no Just)

```powershell
az deployment group what-if  -g nicolas-node-ai-sandbox --template-file infra/world/main.bicep --parameters infra/world/main.bicepparam
az deployment group create   -g nicolas-node-ai-sandbox --template-file infra/world/main.bicep --parameters infra/world/main.bicepparam
az deployment group create   -g nicolas-node-ai-sandbox --template-file infra/world/civ-federation-container.bicep
```
