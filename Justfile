# Cross-language task runner for the AI civilization monorepo.
# Run `just` (or `just --list`) to see all recipes across the civilization app,
# federation contracts, the World runtime, the observer web app, and the test kits.

set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]

# Show available recipes.
default:
    @just --list

# --- Civilization app (Node 22 + TypeScript) ---

# Install all workspace dependencies from the single root lockfile.
install:
    npm ci

# Build the civilization client + server.
build:
    npm run build -w apps/civilization

# Run the civilization test suite (vitest).
test:
    npm run test -w apps/civilization

# Type-check the civilization client.
typecheck:
    npm run typecheck:client -w apps/civilization

# Start the built civilization server (cwd = apps/civilization).
start:
    npm run start -w apps/civilization

# --- Federation contracts (P1: OpenAPI 3.1 -> generated TypeScript + C#) ---

# Full contract quality gate: lint + drift check + tests.
contracts:
    npm run build:contracts

# Lint the OpenAPI document.
contracts-lint:
    npm run lint:contracts

# Regenerate the bundle + TypeScript + C# artifacts.
contracts-generate:
    npm run generate:contracts

# Fail if generated artifacts are out of date (CI drift gate).
contracts-check:
    npm run check:contracts

# Run the schema/example validation tests.
contracts-test:
    npm run test:contracts

# Build the generated C# client (proves it compiles).
contracts-build-csharp:
    dotnet build packages/federation-contracts/csharp/FederationContracts.csproj

# --- Fake civilization federation testkit (P4) ---

# Build and test the fake civilization package.
testkit: testkit-build testkit-test

# Build the reusable library and CLI.
testkit-build:
    npm run build:testkit

# Run the fake civilization package tests.
testkit-test:
    npm run test:testkit

# Run a JSON scenario against the configured World.
testkit-scenario file:
    npm run fake-civ -- scenario {{file}}

# Run the real-process federation end-to-end proof (builds civ + testkit, publishes World, runs Playwright).
federation-e2e:
    npm run test:federation-e2e

# --- World-map runtime (P2: .NET 10 ASP.NET Core World federation service) ---

# Restore the world-map .NET projects.
world-restore:
    dotnet restore AiCivilization.slnx

# Build the world-map API (proves the runtime compiles).
world-build:
    dotnet build apps/world-map/src/WorldMap.Api/WorldMap.Api.csproj -c Debug

# Run the world-map unit + integration test suites.
world-test:
    dotnet test apps/world-map/tests/WorldMap.UnitTests/WorldMap.UnitTests.csproj -c Debug
    dotnet test apps/world-map/tests/WorldMap.IntegrationTests/WorldMap.IntegrationTests.csproj -c Debug

# Run the world-map API locally (in-memory storage; cwd = apps/world-map/src/WorldMap.Api).
world-run:
    dotnet run --project apps/world-map/src/WorldMap.Api/WorldMap.Api.csproj

# --- World-map observer web app (Vite + React + TypeScript) ---

# Start the Vite dev server (proxies /world + /health to the ASP.NET host on :5266).
world-web-dev:
    npm run dev -w apps/world-map/web

# Type-check the observer web app.
world-web-typecheck:
    npm run typecheck -w apps/world-map/web

# Run the observer web app tests (vitest).
world-web-test:
    npm run test -w apps/world-map/web

# Build the observer web app for production (typecheck + vite build -> apps/world-map/web/dist).
world-web-build:
    npm run build -w apps/world-map/web

# Build the whole .NET solution (contracts C# + world-map).
world:
    dotnet build AiCivilization.slnx -c Debug

# --- World-map Azure infrastructure (P7: Bicep IaC + deployment tooling) ---
# See docs/world-deployment-runbook.md for the full provisioning + secret + rollout flow.
# Mutation recipes take an explicit subscription/resource-group; none default a subscription.

# Compile all World Bicep templates + validate the example parameters (no Azure login, no deployment).
world-infra-build:
    az bicep build --file infra/world/main.bicep
    az bicep build --file infra/world/civ-federation-container.bicep
    az bicep build-params --file infra/world/main.bicepparam

# Cosmos container parity (containers.json <-> CosmosContainers.cs) + no-committed-secret scan.
world-infra-check:
    node scripts/check-world-infra.mjs

# Preview World infra changes without applying them.
world-infra-whatif subscription resource_group:
    az deployment group what-if --subscription {{subscription}} --resource-group {{resource_group}} --template-file infra/world/main.bicep --parameters infra/world/main.bicepparam

# Provision/update the World infra (idempotent). Never touches civ resources.
world-infra-deploy subscription resource_group:
    az deployment group create --subscription {{subscription}} --resource-group {{resource_group}} --template-file infra/world/main.bicep --parameters infra/world/main.bicepparam

# Ensure the additive `federation` container exists in the existing civ sandbox database.
world-federation-container subscription resource_group:
    az deployment group create --subscription {{subscription}} --resource-group {{resource_group}} --template-file infra/world/civ-federation-container.bicep

# Publish the World app (builds + bundles the observer SPA, fail-closed) to ./publish/world.
world-publish:
    dotnet publish apps/world-map/src/WorldMap.Api/WorldMap.Api.csproj -c Release -o ./publish/world

# Package the already-published World app (./publish/world) into a checksummed ZIP for deployment.
# Preserves the prior ZIP as ./publish/world.prev.zip so a rollback artifact is always retained.
world-package:
    if (-not (Test-Path ./publish/world/WorldMap.Api.dll)) { throw 'Run `just world-publish` first (no ./publish/world output).' }
    if (Test-Path ./publish/world.zip) { Move-Item ./publish/world.zip ./publish/world.prev.zip -Force }
    Compress-Archive -Path ./publish/world/* -DestinationPath ./publish/world.zip -Force
    (Get-FileHash ./publish/world.zip -Algorithm SHA256).Hash | Tee-Object -FilePath ./publish/world.zip.sha256

# ZIP-deploy the packaged World app, then verify liveness + readiness. Explicit sub/RG/app.
world-deploy-app subscription resource_group app_name:
    if (-not (Test-Path ./publish/world.zip)) { throw 'Run `just world-package` first (no ./publish/world.zip).' }
    az webapp deploy --subscription {{subscription}} --resource-group {{resource_group}} --name {{app_name}} --type zip --src-path ./publish/world.zip
    $base = "https://{{app_name}}.azurewebsites.net"; $ok = $false
    foreach ($i in 1..30) { try { if ((Invoke-WebRequest "$base/health" -UseBasicParsing -TimeoutSec 10).StatusCode -eq 200) { $ok = $true; break } } catch {}; Start-Sleep 5 }
    if (-not $ok) { throw "Liveness /health did not return 200 after deploy." }
    try { $r = (Invoke-WebRequest "$base/health/ready" -UseBasicParsing -TimeoutSec 15).StatusCode } catch { $r = $_.Exception.Response.StatusCode.value__ }
    Write-Host "Deployed. /health=200 /health/ready=$r (200 once schema + lease + secret refs are satisfied)."

# Set a World HMAC secret in Key Vault out-of-band from a SECURE FILE (never a CLI value arg, which
# would leak into process args/shell history). Create the file with restrictive ACLs, then delete it.
world-provision-secret vault secret_name secret_file:
    az keyvault secret set --vault-name {{vault}} --name {{secret_name}} --file {{secret_file}}

# Enable civ->World federation on the EXISTING civ app (phase 2). Set the remaining WORLD_* settings
# (HMAC/onboarding via Key Vault references) per the runbook before running this toggle.
civ-enable-federation subscription resource_group civ_app world_base_url:
    az webapp config appsettings set --subscription {{subscription}} --resource-group {{resource_group}} --name {{civ_app}} --settings WORLD_API_BASE_URL={{world_base_url}}
    az webapp restart --subscription {{subscription}} --resource-group {{resource_group}} --name {{civ_app}}

# Roll back civ federation: remove WORLD_API_BASE_URL (the kill switch) and restart.
civ-rollback-federation subscription resource_group civ_app:
    az webapp config appsettings delete --subscription {{subscription}} --resource-group {{resource_group}} --name {{civ_app}} --setting-names WORLD_API_BASE_URL
    az webapp restart --subscription {{subscription}} --resource-group {{resource_group}} --name {{civ_app}}
