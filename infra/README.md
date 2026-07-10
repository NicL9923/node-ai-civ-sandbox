# Infrastructure

Infra is organized per deployable so each civilization/service owns its own Bicep.

```
infra/
  civilization/
    main.bicep   # Existing AI civilization sandbox (App Service + Cosmos DB + Foundry)
```

## Civilization

`civilization/main.bicep` provisions the existing single-app deployment: a Linux App
Service (`NODE|22-lts`, `appCommandLine: npm start`), Cosmos DB (SQL API), Application
Insights + Log Analytics, and a Microsoft Foundry account/project with model deployments.
Resource names, parameters, and semantics are unchanged from the pre-monorepo layout — this
was a pure file move.

Deploy (unchanged from before, just the new path):

```bash
az deployment group create \
  --resource-group <rg> \
  --template-file infra/civilization/main.bicep \
  --parameters adminApiKey=<secret>
```

> A future deploy pipeline must build/zip the app from `apps/civilization/` so that the
> server's `process.cwd()`-relative static path (`dist/client`) resolves at runtime.

## Future (not in this PR)

- `world-map/` — P2 world composition + world-map service.
- A root composition that wires civilizations into the shared world will be added when the
  world service exists. Intentionally omitted now to avoid implying a working root deploy.
