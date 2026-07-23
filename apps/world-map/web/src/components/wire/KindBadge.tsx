import { accountKindLabel, isOfficialKind, isSystemKind } from "../../domain/social";

/**
 * Account-kind marker rendered as TEXT (never encoded by color alone): official and system
 * accounts get an emphasized bordered chip; agents get a quiet inline label. The label text is the
 * encoding, so it survives greyscale and screen readers.
 */
export function KindBadge({ kind }: { kind: string | undefined }) {
  const label = accountKindLabel(kind);
  const variant = isOfficialKind(kind) ? "official" : isSystemKind(kind) ? "system" : "agent";
  return (
    <span className={`badge badge--${variant}`} aria-label={`${label} account`}>
      {label}
    </span>
  );
}
