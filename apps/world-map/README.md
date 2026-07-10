# World Federation Runtime (`apps/world-map`)

The **World** orchestrator for the AI civilization federation — an ASP.NET Core (.NET 10)
Minimal API that owns the inter-civ registry, public map projection, relationship state, the
interaction ledger, the world-command queue, and the ordered world-event feed.

It implements the v1 protocol defined in [`packages/federation-contracts`](../../packages/federation-contracts)
(OpenAPI 3.1). The runtime conforms to that contract exactly; it does not redefine DTOs.

## Ownership & direction (why it's shaped this way)

- The World is the **sole writer** for the registry/projection, relationships, interactions,
  commands, and world events/sequence. Civilizations own their internal state.
- **Civs initiate every network call**: they PUSH registration/heartbeat/events/interactions,
  PULL commands, and ACK them. The World never calls civ URLs (no SSRF surface, easy onboarding).
- MVP interactions are `contact` and `message` only. No trade/treaty/conflict/migration yet.

## Layout

```
src/
  WorldMap.Api             ASP.NET Core Minimal API host — endpoints, HMAC filter, ProblemDetails,
                           rate limiting, OpenTelemetry, static placeholder, maintenance worker.
  WorldMap.Core            Domain aggregates + state machines, application services, Result<T>,
                           HMAC canonicalizer/signer, wire DTOs (System.Text.Json), config options.
  WorldMap.Infrastructure  In-memory + Azure Cosmos repositories/stores, config-backed secret
                           resolver, readiness probe, DI registration.
tests/
  WorldMap.UnitTests         Domain/service/HMAC/crypto unit tests (incl. the golden signing vectors).
  WorldMap.IntegrationTests  WebApplicationFactory endpoint + contract-conformance tests.
```

## Endpoints (all under `/world/v1`)

| Method & path | Auth |
|---|---|
| `POST /civilizations/register` | onboarding token |
| `POST /civilizations/{civId}/heartbeat` | HMAC |
| `GET /civilizations` · `GET /civilizations/{civId}` | public |
| `POST /civilizations/{civId}/events/batch` | HMAC |
| `GET /civilizations/{civId}/commands` · `POST .../commands/{commandId}/ack` | HMAC |
| `POST /interactions` (202) · `GET /interactions/{interactionId}` | HMAC |
| `GET /relationships` · `GET /events` · `GET /stream` (SSE) | public |

`GET /health` and `GET /health/ready` are unauthenticated. `/` serves a static placeholder for
the future React web app.

## Authentication (HMAC-SHA256)

Authenticated requests are signed exactly per the contract: a 10-field canonical string
(`protocolVersion, civId, keyId, timestamp, nonce, idempotencyKey, METHOD, path, canonicalQuery,
bodySha256Hex`) joined by single LF, signed with the civ's shared secret, sent as
`X-Signature = base64url(HMAC-SHA256(...))`. The World enforces a ±300s window and single-use
nonces. The C# implementation is validated against the shared golden vectors
(`packages/federation-contracts/examples/signing.vector.json`).

Registration binds a civ to an **operator-preprovisioned onboarding record** (a one-time token
mapped to a fixed `civId`/`keyId`/`secretRef`). The World **never mints or returns the HMAC
secret** — the civ receives it out-of-band, and the runtime resolves it via `ISecretStore` from
the `secretRef`. Only credential references/metadata are persisted; no secret material is stored.

In production the secret is provided as an App Service setting backed by a Key Vault reference
(`WorldMap:Secrets:Map:<secretRef>`). In tests a seeded in-memory secret store is injected through
DI (never over HTTP). There is no secret-retrieval endpoint.

## Configuration (`WorldMap` section)

See [`src/WorldMap.Api/appsettings.Example.json`](src/WorldMap.Api/appsettings.Example.json). Key
settings:

- `Storage.Provider` — `InMemory` (default, for local/dev/tests) or `Cosmos`.
- `Storage.CosmosEndpoint` / `Storage.DatabaseName` — Cosmos account endpoint (auth via
  `DefaultAzureCredential`) and the dedicated `worldmap` database.
- `Onboarding.Records` — operator-preprovisioned onboarding records (`token` → `civId`/`keyId`/
  `secretRef`); one-time, never commit real tokens.
- `Secrets.Map` — `secretRef` → shared HMAC secret (App Service settings backed by Key Vault
  references in production; user-secrets/env locally). Never commit real secrets.
- `Telemetry.AzureMonitorConnectionString` — enables the Azure Monitor OpenTelemetry exporter.
- `Liveness`, `Interaction`, `Maintenance` — freshness thresholds, TTLs, and the sweep interval.

**Never commit secrets.** Provide tokens/secrets via environment variables or a secret store, e.g.
`WorldMap__Onboarding__Records__0__Token=<token>` and `WorldMap__Secrets__Map__<secretRef>=<secret>`.

## Running & testing

```bash
just world-build      # build the API
just world-run        # run locally (InMemory storage)
just world-test       # unit + integration tests
# or:
dotnet build apps/world-map/src/WorldMap.Api/WorldMap.Api.csproj
dotnet test  apps/world-map/tests/WorldMap.UnitTests
dotnet test  apps/world-map/tests/WorldMap.IntegrationTests
```

## Scale-out note (worldsequence)

The global `worldsequence` total order is monotonic and correct on a **single** app instance
(the allocator + ledger append are single-instance-consistent). Scaling out requires a lease/block
allocator or a dedicated sequence service — intentionally **not** implemented here, and the code
makes no false distributed-atomicity claims.
