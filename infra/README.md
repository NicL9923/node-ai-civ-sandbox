# Infrastructure

Infra is organized per deployable so each civilization/service owns its own Bicep.

```
infra/
  civilization/
    main.bicep   # Existing AI civilization sandbox (App Service + Cosmos DB + Foundry)
  world/
    main.bicep                      # World runtime (App Service + Cosmos worldmap DB + App Insights + Key Vault + RBAC)
    containers.json                 # Cosmos container / PK / TTL source of truth (lockstep with the runtime)
    civ-federation-container.bicep  # Additive `federation` container for the existing civ database
    civ-federation-secrets.bicep    # Additive dedicated civ Key Vault + civ MI Secrets User role
    main.bicepparam                 # Example parameters (no secrets)
```

## Civilization

`civilization/main.bicep` provisions the existing single-app deployment: a Linux App
Service (`NODE|22-lts`, `appCommandLine: npm start`), Cosmos DB (SQL API) — including the
`federation` container the P3 World connector reads/writes when federation is enabled — Application
Insights + Log Analytics, and a Microsoft Foundry account/project with model deployments. CI compiles
this template with `az bicep build` (no login, no deployment).

Deploy (unchanged from before, just the new path):

```bash
az deployment group create \
  --resource-group <rg> \
  --template-file infra/civilization/main.bicep \
  --parameters adminApiKey=<secret>
```

> A future deploy pipeline must build/zip the app from `apps/civilization/` so that the
> server's `process.cwd()`-relative static path (`dist/client`) resolves at runtime.

## World

`world/main.bicep` provisions a **dedicated** production deployment for the World runtime
(`apps/world-map`): a Linux **.NET 10** App Service (system-assigned identity, HTTPS-only, TLS 1.2+,
FTPS disabled, HTTP/2, health check `/health/ready`, Always On, **scale locked to 1** for the
single-writer lease) on its own App Service plan; a dedicated Application Insights (linked to an
existing Log Analytics workspace by resource ID, or a new one); a new Key Vault (RBAC, soft delete,
purge protection); and the `worldmap` Cosmos SQL database with its 11 containers created inside the
**existing (reused)** Cosmos account. The runtime authenticates to Cosmos with **managed identity
(no account keys)**.

The container set, partition key (`/pk`), and TTL matrix live in `world/containers.json` — the single
source of truth consumed by the Bicep (`loadJsonContent`) and asserted against the runtime's
`CosmosContainers` by `scripts/check-world-infra.mjs` (run in CI + `npm run check:world-infra`).

Secrets are never in the template: onboarding records carry only hashes/refs/names, and HMAC secret
values are generated with a CSPRNG (`scripts/provision-world-onboarding.ps1`) and provisioned
out-of-band into Key Vault (`az keyvault secret set --file`), surfaced to the app via versionless
**Key Vault SecretUri references**. Key Vault purge protection is enabled unconditionally. Two additive
templates touch the existing civ deployment without redeploying it:
`world/civ-federation-container.bicep` (the `federation` container in the civ `sandbox` DB) and
`world/civ-federation-secrets.bicep` (a dedicated civ Key Vault + the civ MI's vault-scoped Secrets
User role, for least-privilege civ secret access).

`scripts/check-world-infra.mjs` + `check-world-infra.selftest.mjs` (CI + `npm run check:world-infra`)
guard: container parity, no committed secret values (across infra **and** the Justfile/runbook/helper
scripts), SecretUri-only references, unconditional purge protection, onboarding-record
shape/format/uniqueness/ordering, the single-generation onboarding flow (credentials generated exactly
once with both `-WorldVault` and `-CivVault`, never a World-only re-run), safe secret-handling (CSPRNG,
no `--value` args, no printed secrets), and the deploy tooling's checksum verification + readiness gate
— with a negative-fixture self-test.

Full provisioning (including a Cosmos capability inventory before choosing throughput mode), secure
secret generation, checksummed publish/ZIP-deploy, verification, least-privilege civ enablement, and
rollback steps are in [`docs/world-deployment-runbook.md`](../docs/world-deployment-runbook.md).
Helper recipes: `just world-infra-build | world-infra-check | world-infra-whatif | world-infra-deploy |
world-publish | world-package | world-deploy-app`. CI compiles all World templates + runs the guard
(no login, no deployment).

## Not included here

- A root composition that wires multiple civilizations into a deployed shared world is out of scope;
  the real-process integration is proven by the federation E2E, not by a deploy.
