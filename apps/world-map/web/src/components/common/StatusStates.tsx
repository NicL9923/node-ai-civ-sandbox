import type { ReactNode } from "react";

/** Shared loading / empty / error primitives. Empty states teach; errors stay safe & retryable. */

export function LoadingState({ label = "Loading the world…" }: { label?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <div style={{ display: "grid", gap: "0.5rem", maxWidth: 320, margin: "0 auto" }}>
        <div className="skeleton" style={{ width: "60%", margin: "0 auto" }} />
        <div className="skeleton" style={{ width: "90%" }} />
        <div className="skeleton" style={{ width: "80%" }} />
        <div className="skeleton" style={{ width: "70%" }} />
      </div>
      <p className="visually-hidden">{label}</p>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state">
      <p className="state__title">{title}</p>
      {children ? <p>{children}</p> : null}
    </div>
  );
}

export function ErrorState({
  title = "Something went wrong",
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="state" role="alert">
      <p className="state__title">{title}</p>
      <p>{message}</p>
      {onRetry ? (
        <button type="button" className="btn" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}
