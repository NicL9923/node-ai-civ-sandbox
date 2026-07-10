# Fake civilization testkit

`@ai-civ/fake-civilization-testkit` is a deterministic, contract-driven client for
testing World Federation integrations. It is a reusable library and the `fake-civ`
CLI. It only makes civilization-initiated HTTP calls; it does not host an inbound
server or simulate a civilization model.

## Configuration and CLI

Run `fake-civ register`, `fake-civ heartbeat`, `fake-civ sync`, or
`fake-civ scenario <file>`. All commands produce JSON on stdout, diagnostics on
stderr, and never prompt. Configuration precedence is command line, `FAKE_CIV_*`
environment variables, JSON `--config`, then defaults. Common variables are
`FAKE_CIV_ALIAS`, `FAKE_CIV_DISPLAY_NAME`, `FAKE_CIV_WORLD_URL`,
`FAKE_CIV_ONBOARDING_TOKEN`, `FAKE_CIV_HMAC_SECRET`, `FAKE_CIV_CIV_ID`, and
`FAKE_CIV_KEY_ID`. `--state` defaults to `.fake-civ-state.json`.

The onboarding token and HMAC secret are out-of-band credentials. State files,
request journals, errors, and normal output exclude them. Registration persists
only the assigned identity and other non-secret state.

Exit codes are `0` success, `1` unexpected failure, `2` usage/configuration,
`3` protocol/auth rejection, `4` transient retries exhausted, and `5` scenario
assertion or unavailable host control.

Example against a future local World API:

```powershell
$env:FAKE_CIV_ALIAS = "aurora"
$env:FAKE_CIV_DISPLAY_NAME = "Aurora"
$env:FAKE_CIV_WORLD_URL = "http://127.0.0.1:5000/world/v1"
$env:FAKE_CIV_ONBOARDING_TOKEN = "<operator-issued-token>"
$env:FAKE_CIV_HMAC_SECRET = "<out-of-band-secret>"

npm run fake-civ -- register --state .aurora-state.json
npm run fake-civ -- heartbeat --state .aurora-state.json
npm run fake-civ -- sync --state .aurora-state.json
```

The World test host must map the onboarding token to the same HMAC secret. The
registration response supplies only `civId` and `keyId`; it never returns the
secret. Prefer environment variables or an injected credential resolver over a
config file for credentials.

## Semantics

Authenticated calls use an independent HMAC-SHA256 implementation over the
federation canonical request format. Mutating retries keep the exact serialized
body and idempotency key while signing each attempt with a fresh timestamp and
nonce. The supplied `ScriptedTransport` records redacted request attempts.

Heartbeats deliberately omit `Idempotency-Key`: their canonical idempotency field
is empty. They are safe to retry because World treats heartbeat as last-write-wins.

`sync()` processes commands only after pulling them, acknowledges every command
with a terminal `applied`, `rejected`, or `duplicate` result, and advances the
cursor only when all ACKs are recorded. Unknown commands are rejected with
`unsupported_command_type` and do not block cursor progress. If ACK retries are
exhausted, the cursor remains unchanged for replay.

## Scenarios

Fixtures under `scenarios/` use schema version `1` and a deliberately small,
non-executable DSL. It supports fixed discriminated operations, absolute JSON Pointer
reads in assertions, primitive equality, and primitive/string/array containment.
There is no interpolation, expression language, or eval. `arrange` is only an
injected `ScenarioHostControls` hook for test hosts. Pure HTTP execution rejects
such a step clearly; it is never a World endpoint.

`replay` references the `id` of an earlier network step and sends the same
operation inputs and idempotency key again. `setAuthFault` provides the fixed
client-side adversarial modes used by the auth fixture. Expected protocol
failures are declared with primitive `expectError.status`/`code` fields.

Run a black-box scenario with:

```powershell
npm run fake-civ -- scenario test/fake-civilization/scenarios/two-civs-contact-message.scenario.json
```

Each actor's `credentialRef` resolves environment variables such as
`FAKE_CIV_SECRET_AURORA` and `FAKE_CIV_ONBOARDING_TOKEN_AURORA`. Scenarios with
`arrange` require an injected library `ScenarioHostControls`; the CLI intentionally
fails those steps against an arbitrary HTTP World.

## Reusing the library in P2/P3 tests

Import `FakeCivilization`, `WorldFederationDriver`, `ScriptedTransport`, or
`runScenario` from `@ai-civ/fake-civilization-testkit`. P2 can implement
`ScenarioHostControls` in its future `WebApplicationFactory` test host to queue
unknown commands, inject transient responses, or force page boundaries. P3 can
run its real connector as one actor and this deterministic package as the second
civilization. Neither integration requires a second LLM or inbound fake-civ
server.
