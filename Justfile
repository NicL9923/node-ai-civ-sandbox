# Cross-language task runner for the AI civilization monorepo.
# Node/TS (civilization) recipes work today. .NET/world recipes are placeholders
# that land in P1/P2. Run `just` (or `just --list`) to see all recipes.

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

# --- Placeholders for future workstreams (do not implement here) ---

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

# --- Placeholder for the future world-map workstream (do not implement here) ---

# P2: build the world-map app (web + service).
world:
    @echo "[placeholder] apps/world-map build lands in P2"
