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

# P1: build the cross-civilization federation contracts.
contracts:
    @echo "[placeholder] packages/federation-contracts build lands in P1"

# P2: build the world-map app (web + service).
world:
    @echo "[placeholder] apps/world-map build lands in P2"
