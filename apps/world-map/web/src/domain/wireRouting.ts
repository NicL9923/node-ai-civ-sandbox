// Pure hash routing for the World Wire surface. Mirrors useSelection's `#key=value` scheme but in
// a distinct `#wire=` namespace so the two coexist: useSelection ignores `wire` keys, and this
// module ignores civ/rel keys. Ids are opaque and URL-encoded; never parsed for meaning.

export const WIRE_TABS = ["posts", "followers", "following", "feed"] as const;
export type WireTab = (typeof WIRE_TABS)[number];

export type WireRoute =
  | { view: "feed" }
  | { view: "account"; accountId: string; tab: WireTab }
  | { view: "post"; postId: string };

function isWireTab(value: string): value is WireTab {
  return (WIRE_TABS as readonly string[]).includes(value);
}

function safeDecode(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value).trim();
    return decoded || null;
  } catch {
    return null;
  }
}

/** True when a location hash addresses the World Wire surface (`#wire=...`). */
export function isWireHash(hash: string): boolean {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  return raw === "wire" || raw.startsWith("wire=");
}

/**
 * Parse a location hash into a `WireRoute`, or null when it is not a wire hash. A bare `#wire`
 * or `#wire=` (and any malformed wire hash) resolves to the feed landing so a deep link is never
 * a dead end.
 */
export function parseWireHash(hash: string): WireRoute | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!isWireHash(raw)) return null;

  const eq = raw.indexOf("=");
  const value = eq < 0 ? "" : raw.slice(eq + 1);
  if (!value) return { view: "feed" };

  const segments = value.split("/");
  const view = safeDecode(segments[0] ?? "");

  if (view === "account") {
    const accountId = safeDecode(segments[1] ?? "");
    if (!accountId) return { view: "feed" };
    const rawTab = segments[2] ? safeDecode(segments[2]) : null;
    const tab: WireTab = rawTab && isWireTab(rawTab) ? rawTab : "posts";
    return { view: "account", accountId, tab };
  }
  if (view === "post") {
    const postId = safeDecode(segments[1] ?? "");
    if (!postId) return { view: "feed" };
    return { view: "post", postId };
  }
  // "feed" or anything unrecognized falls back to the feed landing.
  return { view: "feed" };
}

/** Serialize a `WireRoute` to a hash string including the leading `#`. */
export function wireRouteToHash(route: WireRoute): string {
  switch (route.view) {
    case "feed":
      return "#wire=feed";
    case "account": {
      const base = `#wire=account/${encodeURIComponent(route.accountId)}`;
      return route.tab === "posts" ? base : `${base}/${route.tab}`;
    }
    case "post":
      return `#wire=post/${encodeURIComponent(route.postId)}`;
  }
}
