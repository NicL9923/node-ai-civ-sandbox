# @ai-civ/federation-contracts

The **single source of truth** for the World ⇄ Civilization federation protocol (v1). Hand-authored
OpenAPI 3.1 + modular JSON Schema, with **deterministic, checked-in** TypeScript and C# artifacts
generated for both sides of the wire.

See [`docs/protocol.md`](../../docs/protocol.md) for federation semantics and
[`docs/world-wire-social-contract.md`](../../docs/world-wire-social-contract.md) for the additive
World Wire account/post/follow/reaction contract.

## Layout

```
openapi/
  world.v1.yaml            # root OpenAPI 3.1 document (hand-authored)
  world.v1.bundled.json    # GENERATED single-file bundle (Redocly)
schemas/                   # modular JSON Schema 2020-12 (hand-authored)
  common/ civilization/ relationship/ interaction/ envelope/ social/
examples/                  # JSON fixtures validated by the test suite
generated/
  ts/  world.v1.d.ts       # GENERATED TypeScript types (openapi-typescript)
       client.ts index.ts  # hand-authored thin openapi-fetch client + entry point
  csharp/                  # GENERATED C# client + models (Kiota)
csharp/
  FederationContracts.csproj  # net10.0 wrapper that compiles the generated C#
scripts/  generate.mjs check-drift.mjs
test/     schemas.test.ts openapi.test.ts
```

## Contract source of truth

`openapi/world.v1.yaml` references modular schemas under `schemas/`. Redocly **bundles** them into
`openapi/world.v1.bundled.json`, which is the single file both generators consume. **Edit the YAML
source, never the generated artifacts.**

## Commands

Run from the repo root:

| Task | Command |
|---|---|
| Lint the OpenAPI document | `npm run lint:contracts` |
| Regenerate all artifacts | `npm run generate:contracts` |
| Fail on drift (CI gate) | `npm run check:contracts` |
| Typecheck the TS artifacts | `npm run typecheck:contracts` |
| Schema/example tests | `npm run test:contracts` |
| Full gate (lint + drift + tests) | `npm run build:contracts` |
| Build the generated C# | `dotnet build packages/federation-contracts/csharp` |

`just contracts`, `just contracts-generate`, `just contracts-check`, `just contracts-test` mirror
these.

### After editing the contract

```bash
npm run generate:contracts   # regenerate bundle + TS + C#
git add packages/federation-contracts
```

CI runs `check:contracts`, which regenerates and fails if anything drifts — so **always commit
regenerated artifacts** alongside source changes.

## Toolchain

- **[Redocly CLI](https://redocly.com/docs/cli/)** — OpenAPI 3.1 lint + deterministic bundle.
- **[openapi-typescript](https://openapi-ts.dev/)** — pure TypeScript types (no runtime), paired with
  **[openapi-fetch](https://openapi-ts.dev/openapi-fetch/)** in `generated/ts/client.ts`.
- **[Kiota](https://learn.microsoft.com/openapi/kiota/)** — C# client + models, pinned in
  `.config/dotnet-tools.json` (run `dotnet tool restore`).
- **[ajv](https://ajv.js.org/)** (2020-12) — validates the example fixtures in the test suite.

## Consuming the contracts

### TypeScript (apps/civilization, future apps/world-map/web)

```ts
import { createWorldClient, type components } from "@ai-civ/federation-contracts";

const world = createWorldClient({ baseUrl: "https://world.example.com/world/v1" });
const { data } = await world.GET("/civilizations");

type Relationship = components["schemas"]["Relationship"];
type SocialPost = components["schemas"]["SocialPost"];
```

### C# (future .NET world tooling/tests)

Reference `packages/federation-contracts/csharp/FederationContracts.csproj`
(namespace `AiCiv.FederationContracts`). The generated `WorldFederationClient` and `Models/*` come
from Kiota.

## Generator tradeoffs (known and accepted)

- **Nullable `$ref`s** (e.g. `Cursor`, `WorldSequence`, nullable object refs) are expressed as
  OpenAPI 3.1's `oneOf: [ {$ref}, {type: "null"} ]`. openapi-typescript emits a clean `T | null`;
  **Kiota wraps them** in a small composed type (and logs a benign "Discriminator … is not inherited"
  warning). Functionally correct; C# ergonomics are slightly noisier.
- **`format: uri`/`uri-reference`** are not modeled by Kiota and fall back to `string` (logged as a
  warning). The values are still plain strings on the wire.
- **`data`/`payload` `anyOf`** (typed payloads + open object fallback) is intentional: it keeps known
  payloads typed on both sides while staying forward-compatible for additive event/interaction kinds.
  Kiota emits `*Member1` composed wrapper types for the open branch.
- **`specversion` `const: "1.0"`** narrows to a literal in TypeScript; Kiota treats it as a `string`.

These are deliberate: we favor a faithful, forward-compatible OpenAPI 3.1 contract over
generator-perfect output, and prefer generated models over hand-duplicated DTOs.
