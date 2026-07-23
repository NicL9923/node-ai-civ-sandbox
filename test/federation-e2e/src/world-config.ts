import { createHash, randomBytes } from "node:crypto";

// Fixed, deterministic civ identities. The World's onboarding config binds a token-hash to each
// of these ids, so the fake civ can address the real civ (and vice-versa) by a known id without
// ever hard-coding a P2-derived interaction id.
export const CIV_REAL = "civ_real";
export const KEY_REAL = "key_real";
export const SECRET_REF_REAL = "secret_real";
export const CIV_FAKE = "civ_fake";
export const KEY_FAKE = "key_fake";
export const SECRET_REF_FAKE = "secret_fake";

// Distinctive, DOM-selectable public display names.
export const REAL_DISPLAY_NAME = "AuroraRealE2E";
export const FAKE_DISPLAY_NAME = "FakeDominionE2E";

// Public narratives that intentionally surface in the world event feed and the observer UI.
export const CONTACT_NARRATIVE = "FakeDominionE2E opens diplomatic contact with the Republic.";
export const MESSAGE_NARRATIVE = "FakeDominionE2E sends a public message to the Republic.";

// Private payload sentinels that must NEVER reach a public projection, the observer DOM, or any
// captured diagnostic. These live in the committed scenario JSON payloads (they are markers, not
// credentials) so the privacy scan is deterministic.
export const PRIVATE_EVENT_SENTINEL = "PRIVATE-EVENT-DATA-8f31c2a4";
export const PRIVATE_CONTACT_GREETING = "PRIVATE-CONTACT-GREETING-a17b90de";
export const PRIVATE_MESSAGE_BODY = "PRIVATE-MESSAGE-BODY-6cd44e17";

// Short, real-time liveness thresholds so the real civ transitions to offline deterministically
// once it stops heart-beating. The maintenance sweeper runs every second to apply the transition.
export const LIVENESS_STALE_SECONDS = 2;
export const LIVENESS_OFFLINE_SECONDS = 4;
export const MAINTENANCE_SWEEP_SECONDS = 1;

export interface GeneratedCredentials {
  onboardingTokenReal: string;
  onboardingTokenFake: string;
  hmacSecretReal: string;
  hmacSecretFake: string;
  adminKey: string;
  simulationId: string;
}

/** Every raw credential/secret value generated per run — used only to scan public surfaces for leaks. */
export function secretValues(creds: GeneratedCredentials): string[] {
  return [
    creds.onboardingTokenReal,
    creds.onboardingTokenFake,
    creds.hmacSecretReal,
    creds.hmacSecretFake,
    creds.adminKey,
  ];
}

/** All sentinel markers (public narratives excluded) that must not appear on any public surface. */
export function privateSentinels(): string[] {
  return [PRIVATE_EVENT_SENTINEL, PRIVATE_CONTACT_GREETING, PRIVATE_MESSAGE_BODY];
}

export function generateCredentials(): GeneratedCredentials {
  return {
    onboardingTokenReal: randomBytes(24).toString("hex"),
    onboardingTokenFake: randomBytes(24).toString("hex"),
    hmacSecretReal: randomBytes(32).toString("hex"),
    hmacSecretFake: randomBytes(32).toString("hex"),
    adminKey: randomBytes(24).toString("hex"),
    simulationId: `e2e-${randomBytes(4).toString("hex")}`,
  };
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function worldBaseUrl(worldPort: number): string {
  return `http://127.0.0.1:${worldPort}/world/v1`;
}

/**
 * Configuration handed to the published WorldMap.Api process. World receives only lowercase
 * SHA-256 onboarding token hashes, fixed civ/key/secret-ref bindings, the resolved secret values,
 * short liveness thresholds, and the InMemory provider. No raw onboarding token is ever passed.
 */
export function buildWorldEnv(
  creds: GeneratedCredentials,
  worldPort: number,
  parentEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...parentEnv,
    ASPNETCORE_ENVIRONMENT: "Development",
    ASPNETCORE_URLS: `http://127.0.0.1:${worldPort}`,
    "WorldMap__ProtocolVersion": "1.0.0",
    // Returned to civs in the registration response; must be this process so civs do not redirect away.
    "WorldMap__WorldBaseUrl": worldBaseUrl(worldPort),
    "WorldMap__Storage__Provider": "InMemory",
    "WorldMap__Onboarding__Records__0__TokenHash": sha256Hex(creds.onboardingTokenReal),
    "WorldMap__Onboarding__Records__0__CivId": CIV_REAL,
    "WorldMap__Onboarding__Records__0__KeyId": KEY_REAL,
    "WorldMap__Onboarding__Records__0__SecretRef": SECRET_REF_REAL,
    "WorldMap__Onboarding__Records__1__TokenHash": sha256Hex(creds.onboardingTokenFake),
    "WorldMap__Onboarding__Records__1__CivId": CIV_FAKE,
    "WorldMap__Onboarding__Records__1__KeyId": KEY_FAKE,
    "WorldMap__Onboarding__Records__1__SecretRef": SECRET_REF_FAKE,
    [`WorldMap__Secrets__Map__${SECRET_REF_REAL}`]: creds.hmacSecretReal,
    [`WorldMap__Secrets__Map__${SECRET_REF_FAKE}`]: creds.hmacSecretFake,
    "WorldMap__Liveness__StaleAfterSeconds": String(LIVENESS_STALE_SECONDS),
    "WorldMap__Liveness__OfflineAfterSeconds": String(LIVENESS_OFFLINE_SECONDS),
    "WorldMap__Liveness__SuggestedHeartbeatSeconds": "1",
    "WorldMap__Maintenance__Enabled": "true",
    "WorldMap__Maintenance__SweepIntervalSeconds": String(MAINTENANCE_SWEEP_SECONDS),
  };
}

/**
 * Environment for the real compiled Node civilization. It runs the P3 connector against the World
 * with the Memory store, mock AI, the simulation auto-start disabled, generated admin key, an
 * out-of-band HMAC secret, its onboarding token, and deliberately long connector timers so the
 * background loops never race the explicit admin register/heartbeat/sync triggers.
 */
export function buildCivEnv(
  creds: GeneratedCredentials,
  civPort: number,
  worldPort: number,
  parentEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...parentEnv,
    NODE_ENV: "test",
    PORT: String(civPort),
    SIMULATION_ID: creds.simulationId,
    SIM_AUTO_START: "false",
    AI_PROVIDER: "mock",
    ADMIN_API_KEY: creds.adminKey,
    WORLD_API_BASE_URL: worldBaseUrl(worldPort),
    WORLD_PROTOCOL_VERSION: "1",
    WORLD_HMAC_SECRET: creds.hmacSecretReal,
    WORLD_ONBOARDING_TOKEN: creds.onboardingTokenReal,
    WORLD_DISPLAY_NAME: REAL_DISPLAY_NAME,
    WORLD_HEARTBEAT_INTERVAL_MS: "3600000",
    WORLD_POLL_INTERVAL_MS: "3600000",
    WORLD_OUTBOX_INTERVAL_MS: "3600000",
    WORLD_SOCIAL_SYNC_DEBOUNCE_MS: "0",
    WORLD_SOCIAL_SYNC_INTERVAL_MS: "3600000",
    WORLD_SOCIAL_FEED_INTERVAL_MS: "3600000",
    // Elect a deterministic President quickly, then the E2E pauses the simulation before exercising
    // explicit social actions. This gives account sync a real official account without background races.
    TURN_INTERVAL_MS: "100",
    ELECTION_WINDOW_TURNS: "1",
    PRESIDENT_TERM_TURNS: "1000",
  };
  // Ensure no ambient Cosmos endpoint leaks in and forces the durable store.
  delete env.COSMOS_ENDPOINT;
  return env;
}
