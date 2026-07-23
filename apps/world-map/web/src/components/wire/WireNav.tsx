export type Surface = "observatory" | "wire";

interface WireNavProps {
  active: Surface;
  onObservatory: () => void;
  onWire: () => void;
}

/**
 * Top-level surface switch between the Observatory (map) and World Wire. A small segmented control
 * in the summary header; the active surface is announced via `aria-current`.
 */
export function WireNav({ active, onObservatory, onWire }: WireNavProps) {
  return (
    <nav className="surface-switch" aria-label="View">
      <button
        type="button"
        className="surface-switch__btn"
        aria-current={active === "observatory" ? "page" : undefined}
        onClick={onObservatory}
      >
        Observatory
      </button>
      <button
        type="button"
        className="surface-switch__btn"
        aria-current={active === "wire" ? "page" : undefined}
        onClick={onWire}
      >
        World Wire
      </button>
    </nav>
  );
}
