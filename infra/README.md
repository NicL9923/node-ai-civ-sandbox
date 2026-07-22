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
values are provisioned out-of-band into Key Vault and surfaced to the app via Key Vault references.
`world/civ-federation-container.bicep` additively ensures the `federation` container exists in the
existing civ `sandbox` database without redeploying the civilization template.

Full provisioning, secret generation, publish/ZIP-deploy, verification, civ enablement, and rollback
steps are in [`docs/world-deployment-runbook.md`](../docs/world-deployment-runbook.md). Helper
recipes: `just world-infra-build | world-infra-check | world-infra-whatif | world-infra-deploy |
world-publish | world-deploy-app`. CI compiles all World templates + runs the parity/no-secret check
(no login, no deployment).

## Not included here

- A root composition that wires multiple civilizations into a deployed shared world is out of scope;
  the real-process integration is proven by the federation E2E, not by a deploy.
