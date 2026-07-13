import { useCallback, useEffect, useState } from "react";

/** What the observer currently has focused. Rendered from the URL hash so deep-links work. */
export type Selection =
  | { kind: "civ"; civId: string }
  | { kind: "rel"; a: string; b: string }
  | null;

/** Parse a location hash (e.g. "#civ=civ_1" or "#rel=civ_1~civ_2") into a Selection. */
export function parseSelectionHash(hash: string): Selection {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;
  const eq = raw.indexOf("=");
  if (eq < 0) return null;
  const key = raw.slice(0, eq);
  const value = raw.slice(eq + 1);

  if (key === "civ") {
    const civId = safeDecode(value);
    return civId ? { kind: "civ", civId } : null;
  }
  if (key === "rel") {
    const parts = value.split("~");
    if (parts.length !== 2) return null;
    const a = safeDecode(parts[0]);
    const b = safeDecode(parts[1]);
    if (!a || !b) return null;
    return a <= b ? { kind: "rel", a, b } : { kind: "rel", a: b, b: a };
  }
  return null;
}

/** Serialize a Selection to a hash string (including the leading "#"), or "" for null. */
export function selectionToHash(sel: Selection): string {
  if (!sel) return "";
  if (sel.kind === "civ") return `#civ=${encodeURIComponent(sel.civId)}`;
  return `#rel=${encodeURIComponent(sel.a)}~${encodeURIComponent(sel.b)}`;
}

function safeDecode(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value).trim();
    return decoded || null;
  } catch {
    return null;
  }
}

function currentHash(): string {
  return typeof window === "undefined" ? "" : window.location.hash;
}

/**
 * Selection state synced with the URL hash. Reads the hash on mount, follows browser
 * back/forward via `hashchange`, and writes the hash when the user selects — so selections
 * are deep-linkable and history-navigable.
 */
export function useSelection(): [Selection, (next: Selection) => void] {
  const [selection, setSelection] = useState<Selection>(() => parseSelectionHash(currentHash()));

  useEffect(() => {
    const onHashChange = () => setSelection(parseSelectionHash(currentHash()));
    window.addEventListener("hashchange", onHashChange);
    // Re-sync on mount in case the hash changed before listeners attached.
    onHashChange();
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const select = useCallback((next: Selection) => {
    const nextHash = selectionToHash(next);
    if (nextHash === currentHash() || (nextHash === "" && currentHash() === "")) {
      setSelection(next); // no hash change event will fire; update directly
      return;
    }
    if (nextHash === "") {
      // Clear the fragment without leaving a stray "#".
      const { pathname, search } = window.location;
      window.history.pushState(null, "", pathname + search);
      setSelection(null);
    } else {
      window.location.hash = nextHash; // fires hashchange → state updates + history entry
    }
  }, []);

  return [selection, select];
}
