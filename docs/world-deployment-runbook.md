# World deployment runbook

Provision and operate a production **World Map** deployment (`apps/world-map`) on Azure. The World is
a .NET 10 ASP.NET Core federation service with a bundled React observer SPA, backed by Cosmos DB
(managed-identity auth, no keys) and a single-writer lease (**scale = 1**).

> This runbook performs real Azure changes. Run it only against a subscription you own and after a
> `what-if`. The `infra/world` Bicep is idempotent and never recreates or modifies civilization
> resources. CI validates the templates but never logs in or deploys.

Templates & tooling:

- `infra/world/main.bicep` — plan + Web App + App Insights + Key Vault + Cosmos `worldmap` DB/containers + RBAC.
- `infra/world/containers.json` — Cosmos container / PK / TTL source of truth (kept in lockstep with the runtime).
- `infra/world/civ-federation-container.bicep` — additive `federation` container for the existing civ DB.
- `infra/world/main.bicepparam` — example parameters (no secrets).
- `scripts/check-world-infra.mjs` — container parity + no-secret guard (`npm run check:world-infra`).
- `Justfile` — `world-infra-*`, `world-publish`, `world-deploy-app`, `world-provision-secret`, `civ-*` recipes.

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
az monitor log-analytics workspace list --resource-group nicolas-node-ai-sandbox `
  --query "[].id" --output tsv
```

## 2. Edit parameters

Edit `infra/world/main.bicepparam`. Set at least:

- `existingCosmosAccountName` (default `nicnodeai0706162325`).
- `existingLogAnalyticsWorkspaceResourceId` — the ID from step 1 (or leave blank to create a new one).
- Optionally `worldAppName`, `keyVaultName`, `appServiceSkuName`/`Tier`, `cosmosThroughputMode`.

Leave `onboardingRecords = []` for the first deploy (Key Vault references only resolve after their
secrets exist — see step 5).

Validate locally (no login):

```powershell
just world-infra-build      # compiles all templates + validates the .bicepparam
just world-infra-check      # container parity + no-secret scan
```

## 3. Preview (what-if)

```powershell
just world-infra-whatif bce49949-4505-4c57-9207-a84ce0f5c935 nicolas-node-ai-sandbox
```

Confirm it creates only World resources (plan, site, App Insights, Key Vault, `worldmap` DB + 11
containers, 2 role assignments) and shows **no changes** to civilization resources.

## 4. Provision infrastructure (first pass, no onboarding records)

```powershell
just world-infra-deploy bce49949-4505-4c57-9207-a84ce0f5c935 nicolas-node-ai-sandbox
```

This is idempotent. Capture the outputs (`worldAppName`, `worldAppUrl`, `worldBaseUrl`,
`keyVaultName`, `cosmosEndpoint`).

## 5. Securely generate & store onboarding tokens + HMAC secrets

Secrets are provisioned **out-of-band** — never in Bicep, app settings, or source. For each civ:

```powershell
# 1. Onboarding token (raw, given to the civ ONCE) + its SHA-256 hash (stored as config).
$token = -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
$tokenHash = (Get-FileHash -InputStream ([IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes($token))) `
  -Algorithm SHA256).Hash.ToLower()

# 2. Shared HMAC secret (exchanged with the civ out-of-band).
$hmac = -join ((1..48) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })

# 3. Store the HMAC secret VALUE in the World Key Vault (never the token).
just world-provision-secret <worldKeyVaultName> aurora-hmac-v1 $hmac

Write-Host "Give the civ operator this onboarding token (once): $token"
Write-Host "TokenHash for onboardingRecords: $tokenHash"
```

> Prefer `openssl rand -hex 32` / a CSPRNG-backed generator in real environments. The token is
> single-use and must never be logged, committed, or reused as an id.

## 6. Wire onboarding records & re-deploy

Uncomment/populate `onboardingRecords` in `main.bicepparam` with the **non-secret** binding
(`tokenHash`, `civId`, `keyId`, `secretRef`, `secretName`), e.g.:

```bicep
param onboardingRecords = [
  {
    tokenHash: '<from step 5>'
    civId: 'civ_aurora'
    keyId: 'key_01'
    secretRef: 'aurora-hmac-v1'
    secretName: 'aurora-hmac-v1'
  }
]
```

Re-deploy so the app settings + Key Vault references are created now that the secret exists:

```powershell
just world-infra-check
just world-infra-deploy bce49949-4505-4c57-9207-a84ce0f5c935 nicolas-node-ai-sandbox
az webapp restart --subscription bce49949-4505-4c57-9207-a84ce0f5c935 `
  --resource-group nicolas-node-ai-sandbox --name <worldAppName>
```

## 7. Publish & ZIP-deploy the app

`dotnet publish` builds + bundles the observer SPA (fail-closed) into `wwwroot`.

```powershell
just world-publish
just world-deploy-app bce49949-4505-4c57-9207-a84ce0f5c935 nicolas-node-ai-sandbox <worldAppName>
```

## 8. Verify

```powershell
$base = "https://<worldAppName>.azurewebsites.net"
curl.exe -s $base/health                       # {"status":"healthy"}  (liveness)
curl.exe -s -o /dev/null -w "%{http_code}" $base/health/ready   # 200 once schema + lease are satisfied
curl.exe -s "$base/world/v1/civilizations"     # JSON envelope {"items":[...]}
curl.exe -s -H "Accept: text/html" $base/some/deep/link | Select-String "assets/index"  # SPA shell
```

Checklist:

- **Schema** — `/health/ready` returns 200. A non-200 body names the failing check (missing container,
  wrong PK, missing/destructive TTL, or lease not held). `BootstrapEnabled` is **false** in
  production; the Bicep provisions the schema and readiness only validates it.
- **Single-writer lease** — with exactly one instance the lease is held and readiness passes. Never
  scale the plan past 1: a second instance fails readiness by design.
- **SPA** — root and deep links serve the hashed SPA index; unknown API routes return 404, not HTML.
- **Telemetry** — traces/metrics appear in the World Application Insights (`<worldAppName>-insights`)
  via the OpenTelemetry Azure Monitor exporter (`WorldMap__Telemetry__AzureMonitorConnectionString`).

## 9. Enable the civilization → World connector (phase 2)

The P3 connector is off until `WORLD_API_BASE_URL` is set on the existing civ app.

1. Ensure the additive `federation` container exists in the civ `sandbox` DB (idempotent):

   ```powershell
   just world-federation-container bce49949-4505-4c57-9207-a84ce0f5c935 nicolas-node-ai-sandbox
   ```

2. Store the civ's HMAC secret + onboarding token in a **civ-scoped** Key Vault (see the
   least-privilege note below), then set the civ app settings as Key Vault references. Required
   `WORLD_*` settings on the civ app:

   | Setting | Value |
   | --- | --- |
   | `WORLD_API_BASE_URL` | the World `worldBaseUrl` output (`https://<host>/world/v1`) |
   | `WORLD_HMAC_SECRET` | `@Microsoft.KeyVault(VaultName=<civVault>;SecretName=<name>)` |
   | `WORLD_ONBOARDING_TOKEN` *or* `WORLD_CIV_ID`+`WORLD_KEY_ID` | KV reference / provisioned pair |
   | `WORLD_DISPLAY_NAME` | optional display name |

   Set `WORLD_API_BASE_URL` **last** so federation only turns on once the credentials resolve:

   ```powershell
   just civ-enable-federation bce49949-4505-4c57-9207-a84ce0f5c935 nicolas-node-ai-sandbox `
     nic-node-ai-0706162325 "https://<worldAppName>.azurewebsites.net/world/v1"
   ```

3. Drive the connector via the civ admin API (behind `ADMIN_API_KEY`):

   ```powershell
   $civ = "https://nic-node-ai-0706162325.azurewebsites.net"
   $h = @{ "x-admin-api-key" = "<ADMIN_API_KEY>" }
   Invoke-RestMethod -Method Post -Uri "$civ/api/admin/federation/register"  -Headers $h
   Invoke-RestMethod -Method Post -Uri "$civ/api/admin/federation/heartbeat" -Headers $h
   Invoke-RestMethod -Method Post -Uri "$civ/api/admin/federation/sync"      -Headers $h
   Invoke-RestMethod -Method Get  -Uri "$civ/api/admin/federation/status"    -Headers $h
   ```

> **Least-privilege note.** The built-in *Key Vault Secrets User* role is vault-scoped. Put each
> civ's HMAC secret in a **separate civ vault** (recommended) — or scope the civ MI's role assignment
> to the individual secret — so a civ can never read another civ's secret from the shared World vault.

## 10. Rollback

- **Disable civ federation (kill switch):**

  ```powershell
  just civ-rollback-federation bce49949-4505-4c57-9207-a84ce0f5c935 nicolas-node-ai-sandbox nic-node-ai-0706162325
  ```

  Removing `WORLD_API_BASE_URL` + restart disables the connector; the `federation` container and civ
  state are left intact.

- **World app:** redeploy a previous publish artifact (`just world-deploy-app ...`).
- **World infra:** the templates are idempotent; re-deploy a known-good `main.bicepparam`. The
  `worldmap` database and durable containers persist independently of the app.

## Portal deep links

- World app: `https://portal.azure.com/#@bb34272d-0432-4e5e-9f0f-e7aca4a450a8/resource/subscriptions/bce49949-4505-4c57-9207-a84ce0f5c935/resourceGroups/nicolas-node-ai-sandbox/providers/Microsoft.Web/sites/<worldAppName>`
- Resource group: `https://portal.azure.com/#@bb34272d-0432-4e5e-9f0f-e7aca4a450a8/resource/subscriptions/bce49949-4505-4c57-9207-a84ce0f5c935/resourceGroups/nicolas-node-ai-sandbox/overview`

## Raw deploy commands (no Just)

```powershell
az deployment group what-if  -g nicolas-node-ai-sandbox --template-file infra/world/main.bicep --parameters infra/world/main.bicepparam
az deployment group create   -g nicolas-node-ai-sandbox --template-file infra/world/main.bicep --parameters infra/world/main.bicepparam
az deployment group create   -g nicolas-node-ai-sandbox --template-file infra/world/civ-federation-container.bicep
```
