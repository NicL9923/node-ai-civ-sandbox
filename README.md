# AI Civilization Monorepo

A polyglot monorepo for the AI civilization sandbox and the future multi-civilization world.
Today it contains a single runnable app — the **civilization** sandbox (Node 22 + Express 5 +
React/Vite + TypeScript). Additional workstreams (federation contracts, world-map) are scaffolded
as placeholders and land in later phases.

## Layout

```
.
├── apps/
│   ├── civilization/          # The AI civilization sandbox (Node/TS) — the only runnable app
│   └── world-map/             # [placeholder] P2 world-map app (web + service)
├── packages/
│   └── federation-contracts/  # P1 World<->Civilization protocol (OpenAPI 3.1 + generated TS/C#)
├── infra/
│   ├── civilization/main.bicep  # Civilization Azure deployment (App Service + Cosmos + Foundry)
│   └── README.md
├── test/
│   └── fake-civilization/     # [placeholder] fake-civilization test harness
├── docs/                      # [placeholder] architecture & design docs
├── package.json               # Thin root — npm workspaces + delegating scripts
├── package-lock.json          # Single authoritative workspace lockfile
├── Justfile                   # Cross-language task runner (Node today; .NET/world placeholders)
├── global.json                # Pins the .NET 10 SDK for future .NET projects
├── Directory.Build.props      # Safe repo-wide MSBuild defaults for future .NET projects
└── AiCivilization.slnx        # Empty placeholder solution
```

## Prerequisites

- Node.js 22 (`>=22 <25`) and npm
- Optional: [`just`](https://github.com/casey/just) for the task runner
- .NET 10 SDK — required to generate/build the federation contracts' C# artifacts (P1); still
  optional for the civilization app

## Local commands

Install once from the repo root (single workspace lockfile):

```bash
npm ci
```

| Task | npm (root) | just |
|---|---|---|
| Build civilization | `npm run build` | `just build` |
| Test civilization | `npm test` | `just test` |
| Type-check client | `npm run typecheck` | `just typecheck` |
| Start built server | `npm run start:civilization` | `just start` |
| Dev server (API) | `npm run dev:civilization` | — |

`build` / `test` / `typecheck` delegate to the `apps/civilization` workspace via
`-w apps/civilization`.

## Federation contracts (P1)

`packages/federation-contracts` is the versioned source of truth for the World ⇄ Civilization
protocol: hand-authored OpenAPI 3.1 + modular JSON Schema, with deterministic, checked-in TypeScript
(openapi-typescript) and C# (Kiota) artifacts. See its
[README](packages/federation-contracts/README.md) and the protocol semantics in
[`docs/protocol.md`](docs/protocol.md).

| Task | npm (root) | just |
|---|---|---|
| Lint OpenAPI | `npm run lint:contracts` | `just contracts-lint` |
| Regenerate artifacts | `npm run generate:contracts` | `just contracts-generate` |
| Fail on drift | `npm run check:contracts` | `just contracts-check` |
| Contract tests | `npm run test:contracts` | `just contracts-test` |
| Full contract gate | `npm run build:contracts` | `just contracts` |

Regenerating requires the pinned Kiota tool: `dotnet tool restore` (manifest in
`.config/dotnet-tools.json`).

### Running the civilization app directly

Copy the app's env template and start it (the server resolves static assets relative to its
working directory, so start it from the app root or via the workspace script):

```bash
cp apps/civilization/.env.example apps/civilization/.env
# from repo root:
npm run build && npm run start:civilization
# or from the app itself:
cd apps/civilization && npm run build && npm start
```

The app listens on `PORT` (default `3000`) and serves the built client from
`apps/civilization/dist/client`. With `AI_PROVIDER=mock` no model calls are made.

## Infrastructure

See [`infra/README.md`](infra/README.md). The civilization deployment is unchanged from before
the monorepo move — only its path changed to `infra/civilization/main.bicep`. Deployment is not
run by CI in this repo.

## CI

`.github/workflows/ci.yml` runs two jobs on changes under `apps/civilization/**`, `packages/**`, or
the root workspace/.NET files:

- **civilization** — `npm ci` → `npm run build` → `npm test` on Node 22 (Ubuntu).
- **contracts** — on Ubuntu **and** Windows: `npm ci`, `dotnet tool restore`, OpenAPI lint, contract
  **drift check** (regenerate + diff), typecheck, tests, and a C# build.

No deployment workflow is included.
