import { useId, useState } from "react";

interface ExpandableTextProps {
  text: string;
  /** Character budget before clamping. */
  clampChars?: number;
  className?: string;
}

/**
 * Renders bounded narrative as plain text (never innerHTML). Long text is clamped with an
 * accessible Show more / Show less toggle (aria-expanded + aria-controls) so the full narrative is
 * always reachable by keyboard and screen readers without overflowing the panel.
 */
export function ExpandableText({ text, clampChars = 180, className }: ExpandableTextProps) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const needsClamp = text.length > clampChars;

  if (!needsClamp) {
    return <p className={className}>{text}</p>;
  }

  const shown = expanded ? text : `${text.slice(0, clampChars).trimEnd()}…`;
  return (
    <div>
      <p className={className} id={id}>
        {shown}
      </p>
      <button
        type="button"
        className="btn-link"
        aria-expanded={expanded}
        aria-controls={id}
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? "Show less" : "Show more"}
      </button>
    </div>
  );
}
