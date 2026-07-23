# World deployment runbook

Provision and operate a production **World Map** deployment (`apps/world-map`) on Azure. The World is
a .NET 10 ASP.NET Core federation service with a bundled React observer SPA, backed by Cosmos DB
(managed-identity auth, no keys) and a single-writer lease (**scale = 1**).

> This runbook performs real Azure changes. Run it only against a subscription you own and after a
> `what-if`. The `infra/world` Bicep is idempotent and never recreates or modifies civilization
> resources. CI validates the templates but never logs in or deploys.

Templates & tooling:

- `infra/world/main.bicep` — plan + Web App + App Insights + Key Vault + Cosmos `worldmap` DB/containers + RBAC.
- `infra/world/containers.json` — Cosmos container / PK / TTL / unique-key source of truth (lockstep with the runtime; `worldEvents` carries the `/payload/worldsequence` unique key backstop). The authoritative container list **and count** live in this file — do not hardcode the count in prose. <!-- world-container-count: 18 -->
- `infra/world/civ-federation-container.bicep` — additive `federation` container for the existing civ DB.
- `infra/world/civ-federation-secrets.bicep` — additive dedicated civ Key Vault + civ MI Secrets User role.
- `infra/world/main.bicepparam` — example parameters (no secrets).
- `scripts/check-world-infra.mjs` (+ `.selftest.mjs`) — parity + no-secret + onboarding + secret-handling + deploy-tooling guard (`npm run check:world-infra`).
- `scripts/provision-world-onboarding.ps1` / `remove-secure-temp.ps1` — CSPRNG secret provisioning + secure cleanup.
- `scripts/package-world-app.ps1` / `deploy-world-app.ps1` — checksummed package + health-gated deploy/rollback.
- `Justfile` — `world-infra-*`, `world-publish`, `world-package`, `world-deploy-app`, `world-deploy-prev`, `world-civ-secrets-vault`, `civ-*` recipes (credential generation is run directly per §7, not via a recipe).

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
- `cosmosThroughputMode` (+ RU/s) per the §2 inventory.
- `existingLogAnalyticsWorkspaceResourceId` — the ID from §1 (or leave blank to create a new one).
- Optionally `worldAppName`, `keyVaultName`, `appServiceSkuName`/`Tier`.

Leave `onboardingRecords = []` for the first deploy (Key Vault references only resolve after their
World-vault secrets exist — created in §7, wired in §8). Validate locally (no login):

```powershell
just world-infra-build      # compiles all templates + validates the .bicepparam
just world-infra-check      # parity + no-secret + onboarding-record + secret-handling guards
```

## 4. Preview (what-if)

> **Fail-closed prerequisite — `worldEvents` unique key is immutable.** Cosmos unique-key policies
> **cannot be changed after a container is created**. `worldEvents` **must** be created greenfield with the
> unique key `/payload/worldsequence` (the structural duplicate-`worldsequence` backstop). The bootstrapper
> sets this on first provisioning and **cannot retrofit it** onto a pre-existing container; if a
> `worldEvents` container already exists **without** (or with the wrong) unique key, `/health/ready` will
> **fail closed** and the runtime will not serve. In that case **stop** and safely recreate only the
> **undeployed / empty** `worldEvents` container (or the not-yet-provisioned World database) — with the
> unique key set at creation — **never delete a deployed or non-empty event ledger**. The World has **not
> been deployed yet**, so this first rollout is greenfield and safe.

```powershell
just world-infra-whatif bce49949-4505-4c57-9207-a84ce0f5c935 nicolas-node-ai-sandbox
```

Confirm it creates only World resources (plan, site, App Insights, Key Vault, the `worldmap` DB + its
full container set defined in `infra/world/containers.json` — `worldEvents` with the
`/payload/worldsequence` unique key — plus 2 role assignments) and shows **no changes** to civilization
resources.

## 5. Provision World infrastructure (first pass, no onboarding records)

The first deploy has `onboardingRecords = []`, so **no** `WorldMap__Secrets__Map__*` settings are
created and there are **no** unresolved Key Vault references — the app comes up cleanly on an empty
onboarding set.

```powershell
just world-infra-deploy bce49949-4505-4c57-9207-a84ce0f5c935 nicolas-node-ai-sandbox
```

Idempotent. Capture the outputs (`worldAppName`, `worldAppUrl`, `worldBaseUrl`, `keyVaultName`,
`keyVaultUri`, `cosmosEndpoint`, `worldPrincipalId`).

## 6. Deploy the additive civ templates (before credentials)

Both civ vaults/containers must exist **before** credential generation, so the one-time helper run in
§7 can write to them. These templates are additive and never redeploy the civ app.

```powershell
$sub = "bce49949-4505-4c57-9207-a84ce0f5c935"; $rg = "nicolas-node-ai-sandbox"

# a) The `federation` container in the existing civ `sandbox` DB (idempotent).
just world-federation-container $sub $rg

# b) A dedicated civ Key Vault (RBAC, soft delete, unconditional purge protection, no access policies)
#    + the civ Web App MI granted Key Vault Secrets User scoped to THAT vault only (least privilege —
#    the civ MI never touches the World vault). Holds no secret values.
just world-civ-secrets-vault-whatif $sub $rg    # preview
just world-civ-secrets-vault $sub $rg           # deploy -> outputs civKeyVaultName / civKeyVaultUri
```

## 7. Generate the onboarding credentials ONCE (World + civ vaults)

> **Critical:** generate the token + HMAC **exactly once**, and provision the *same* material to both
> vaults in that single run. Never run the helper a second time for the same civ — a re-run mints a
> **different** token/HMAC, so the World's trusted `tokenHash` would no longer match the civ's token
> and registration would fail.

The CSPRNG helper writes the token + HMAC to a restricted-ACL temp dir, provisions the **same** HMAC to
the World vault and to the civ vault, writes the raw onboarding token to the civ vault, cleans up the
temp material after all provisioning succeeds, and returns **only** the non-secret `tokenHash`:

```powershell
$result = ./scripts/provision-world-onboarding.ps1 -WorldVault <worldKeyVaultName> `
  -HmacSecretName aurora-hmac-v1 -CivVault <civKeyVaultName> `
  -CivHmacSecretName civ-aurora-hmac-v1 -CivOnboardingSecretName civ-aurora-onboarding-v1 -Subscription $sub
$result.TokenHash   # non-secret; use for the World onboardingRecords in §8
```

> The helper never prints or returns the raw token/secret; it provisions via `az keyvault secret set
> --file --output none`. It uses a CSPRNG (or use `openssl rand -hex 32` / `-hex 48`).

**External-civ path (mutually exclusive).** If the civ is operated elsewhere and you cannot reach its
vault, run the helper **once** with `-RetainTransferFiles` and **omit** `-CivVault`. It provisions the
World-vault HMAC, retains the raw token + HMAC in a secure temp directory, and returns its path; the
external operator securely transfers those files into their own vault. **Do not run the helper again** —
use the single returned `tokenHash` for `onboardingRecords`. Clean up after transfer.

```powershell
# EXTERNAL civ only — do NOT combine with the managed run above.
$result = ./scripts/provision-world-onboarding.ps1 -WorldVault <worldKeyVaultName> `
  -HmacSecretName aurora-hmac-v1 -RetainTransferFiles -Subscription $sub
$result.TokenHash              # non-secret; use for onboardingRecords
$result.RetainedTransferPath   # transfer securely, then: ./scripts/remove-secure-temp.ps1 -Path <path>
```

## 8. Wire onboarding records & re-deploy World (deterministic)

Populate `onboardingRecords` in `main.bicepparam` with the **non-secret** binding, **stably sorted by
`civId`** (the guard enforces this — records map to `WorldMap__Onboarding__Records__<i>__*`, so a
stable order avoids index churn across deploys):

```bicep
param onboardingRecords = [
  {
    tokenHash: '<$result.TokenHash from §7>'  // lowercase 64-hex SHA-256
    civId: 'civ_aurora'
    keyId: 'key_01'
    secretRef: 'aurora-hmac-v1'  // [A-Za-z0-9_-]{1,64}
    secretName: 'aurora-hmac-v1' // World Key Vault secret name [0-9A-Za-z-]{1,127}
  }
]
```

Re-deploy. App settings are declarative in ARM, so the deployment **replaces** the full app-setting
set: adding/removing/reordering records deterministically updates `Records__<i>__*` and
`Secrets__Map__*`. The referenced World Key Vault secret **must already exist** (§7) so the SecretUri
reference resolves.

```powershell
just world-infra-check      # validates the records (format, uniqueness, sort order)
just world-infra-deploy bce49949-4505-4c57-9207-a84ce0f5c935 nicolas-node-ai-sandbox
az webapp restart --subscription bce49949-4505-4c57-9207-a84ce0f5c935 `
  --resource-group nicolas-node-ai-sandbox --name <worldAppName>
```

Verify every World Key Vault reference resolved before relying on federation:

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

## 9. Publish, package (checksummed), & deploy the app

`dotnet publish` builds + bundles the observer SPA (fail-closed) into `wwwroot`. `world-package`
(`scripts/package-world-app.ps1`) zips + SHA-256-checksums the output and moves the previous ZIP **and
its checksum** to `world.prev.zip` / `world.prev.zip.sha256`. `world-deploy-app`
(`scripts/deploy-world-app.ps1`) verifies the ZIP against its checksum before deploying, then gates on
health — it polls **both** `/health` and `/health/ready` to HTTP 200 within bounded deadlines and
**throws** on timeout/connection failure/non-200 (it never reports success on an unhealthy app).

```powershell
just world-publish
just world-package          # -> ./publish/world.zip (+ .sha256); prior kept as world.prev.zip(.sha256)
just world-deploy-app bce49949-4505-4c57-9207-a84ce0f5c935 nicolas-node-ai-sandbox <worldAppName>
```

If `world-deploy-app` throws on the health gate, the app may be unhealthy — roll back to the retained,
checksum-verified previous artifact (see §12); it does **not** auto-roll-back.

## 10. Verify

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

## 11. Enable the civilization → World connector (phase 2)

The civ secrets were provisioned into the civ vault in §7, so the civ MI can already read them. Set the
civ app's `WORLD_*` settings as **versionless SecretUri** Key Vault references to the **civ** vault,
then flip `WORLD_API_BASE_URL` **last** so federation only turns on once the credentials resolve:

| Setting | Value |
| --- | --- |
| `WORLD_HMAC_SECRET` | `@Microsoft.KeyVault(SecretUri=https://<civVault>.vault.azure.net/secrets/civ-aurora-hmac-v1/)` |
| `WORLD_ONBOARDING_TOKEN` | `@Microsoft.KeyVault(SecretUri=https://<civVault>.vault.azure.net/secrets/civ-aurora-onboarding-v1/)` |
| `WORLD_DISPLAY_NAME` | optional display name |
| `WORLD_API_BASE_URL` | the World `worldBaseUrl` output (set last) |

```powershell
just civ-enable-federation $sub $rg nic-node-ai-0706162325 "https://<worldAppName>.azurewebsites.net/world/v1"
```

Drive the connector via the civ admin API (behind `ADMIN_API_KEY`):

```powershell
$civ = "https://nic-node-ai-0706162325.azurewebsites.net"
$h = @{ "x-admin-api-key" = "<ADMIN_API_KEY>" }
Invoke-RestMethod -Method Post -Uri "$civ/api/admin/federation/register"  -Headers $h
Invoke-RestMethod -Method Post -Uri "$civ/api/admin/federation/heartbeat" -Headers $h
Invoke-RestMethod -Method Post -Uri "$civ/api/admin/federation/sync"      -Headers $h
Invoke-RestMethod -Method Get  -Uri "$civ/api/admin/federation/status"    -Headers $h
```

> **Shared-vault alternative (only if you cannot use a dedicated civ vault).** Grant the civ MI a role
> assignment at the individual secret scope (`<vault id>/secrets/<name>`) and verify it; STOP + fall
> back to a separate vault if secret-level scope is rejected. Never broaden the civ MI to the World
> vault.

## 12. Rollback

- **Disable civ federation (kill switch):**

  ```powershell
  just civ-rollback-federation bce49949-4505-4c57-9207-a84ce0f5c935 nicolas-node-ai-sandbox nic-node-ai-0706162325
  ```

  Removing `WORLD_API_BASE_URL` + restart disables the connector; the `federation` container and civ
  state are left intact.

- **World app:** roll back to the retained, checksum-verified previous artifact
  (`./publish/world.prev.zip`, checksum `./publish/world.prev.zip.sha256`):

  ```powershell
  just world-deploy-prev bce49949-4505-4c57-9207-a84ce0f5c935 nicolas-node-ai-sandbox <worldAppName>
  ```

  `world-deploy-prev` verifies `world.prev.zip` against `world.prev.zip.sha256` before deploying and
  re-gates on `/health` + `/health/ready`.
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
az deployment group create   -g nicolas-node-ai-sandbox --template-file infra/world/civ-federation-secrets.bicep
```
