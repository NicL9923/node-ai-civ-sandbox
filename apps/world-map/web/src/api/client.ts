import createOpenapiClient, { type Client } from "openapi-fetch";
import type { paths } from "@ai-civ/federation-contracts";

// The contracts package exports the OpenAPI `paths` types but not a runtime client wrapper
// (its "./client" entry is types-only). Per the plan we pair those generated types with
// openapi-fetch directly — consuming the contract, duplicating no models, touching no P1 code.
export type WorldClient = Client<paths>;

/**
 * Base path of the World federation API. The OpenAPI paths are relative (e.g. `/civilizations`);
 * the runtime mounts them under `/world/v1`. In dev, Vite proxies `/world` to the ASP.NET host;
 * in production the SPA is served same-origin by that host, so a relative base works everywhere.
 */
export const WORLD_API_BASE = "/world/v1";

/** Absolute-or-relative origin the SPA talks to. Overridable for tests / non-proxied dev. */
export function resolveBaseUrl(baseUrl?: string): string {
  if (baseUrl) return baseUrl;
  if (typeof window !== "undefined" && window.location) {
    return `${window.location.origin}${WORLD_API_BASE}`;
  }
  return WORLD_API_BASE;
}

export function createClient(baseUrl?: string): WorldClient {
  return createOpenapiClient<paths>({ baseUrl: resolveBaseUrl(baseUrl) });
}
