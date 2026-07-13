import type { StreamStatus } from "../../api/sse";

const LABEL: Record<StreamStatus, string> = {
  idle: "Not connected",
  connecting: "Connecting…",
  open: "Live",
  reconnecting: "Reconnecting…",
  offline: "Offline — polling for updates",
};

/**
 * Live-stream connection indicator. The visible pill shows the current state; an associated
 * polite live region announces changes to assistive tech without stealing focus.
 */
export function ConnectionStatus({ status }: { status: StreamStatus }) {
  const label = LABEL[status];
  const modifier = status === "open" ? "conn--open" : status === "offline" ? "conn--offline" : "";
  return (
    <>
      <span className={`conn ${modifier}`.trim()} title={label}>
        <span className="conn__dot" aria-hidden="true" />
        <span>{label}</span>
      </span>
      <span className="visually-hidden" role="status" aria-live="polite">
        World event stream: {label}
      </span>
    </>
  );
}
