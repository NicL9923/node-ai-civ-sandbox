import { useCallback, useEffect, useState } from "react";
import { isWireHash, parseWireHash, wireRouteToHash, type WireRoute } from "../domain/wireRouting";

function currentHash(): string {
  return typeof window === "undefined" ? "" : window.location.hash;
}

/**
 * World Wire route state synced with the URL hash. Reads on mount, follows browser back/forward
 * via `hashchange`, and pushes a new hash on navigation — so wire views are deep-linkable and
 * history-navigable. Returns `null` when the hash is not a wire hash (the observatory is active).
 * Coexists with useSelection: each hook only acts on its own hash namespace.
 */
export function useWireRoute(): {
  route: WireRoute | null;
  navigate: (route: WireRoute) => void;
  exit: () => void;
} {
  const [route, setRoute] = useState<WireRoute | null>(() => parseWireHash(currentHash()));

  useEffect(() => {
    const onHashChange = () => setRoute(parseWireHash(currentHash()));
    window.addEventListener("hashchange", onHashChange);
    onHashChange(); // re-sync in case the hash changed before the listener attached
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = useCallback((next: WireRoute) => {
    const nextHash = wireRouteToHash(next);
    if (nextHash === currentHash()) {
      setRoute(next); // no hashchange event will fire; update directly
      return;
    }
    window.location.hash = nextHash; // fires hashchange → state + history entry
  }, []);

  const exit = useCallback(() => {
    if (isWireHash(currentHash())) {
      const { pathname, search } = window.location;
      window.history.pushState(null, "", pathname + search);
      setRoute(null);
    }
  }, []);

  return { route, navigate, exit };
}
