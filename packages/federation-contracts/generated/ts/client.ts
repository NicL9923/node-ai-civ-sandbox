// Hand-authored thin client wrapper (NOT generated). Pairs the generated
// `paths` types with openapi-fetch to give apps/civilization and the future
// apps/world-map/web a typed World client with zero hand-duplicated DTOs.
import createClient, { type ClientOptions } from "openapi-fetch";
import type { paths } from "./world.v1.js";

/** Create a typed openapi-fetch client for the World Federation API. */
export function createWorldClient(options: ClientOptions) {
  return createClient<paths>(options);
}

export type WorldClient = ReturnType<typeof createWorldClient>;
