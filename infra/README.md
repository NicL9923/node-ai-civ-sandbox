# Infrastructure

Infra is organized per deployable so each civilization/service owns its own Bicep.

```
infra/
  civilization/
    main.bicep   # Existing AI civilization sandbox (App Service + Cosmos DB + Foundry)
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

## Not included here

- `world-map/` — the World runtime (`apps/world-map`) and observer exist as code and run locally on
  the InMemory provider (see the repo README's federation E2E), but a production world-map deployment
  template is intentionally out of scope for this repo.
- A root composition that wires multiple civilizations into a deployed shared world is likewise out of
  scope; the real-process integration is proven by the federation E2E, not by a deploy.
