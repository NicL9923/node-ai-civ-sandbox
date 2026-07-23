import { randomUUID } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

// Process-monotonic enqueue ordinal. Assigned at outbox-item creation and persisted on the item so the
// connector has a deterministic causal tie-breaker for items sharing a millisecond `createdAt` (JS is
// single-threaded and enqueues are awaited sequentially, so an earlier enqueue always gets a lower
// value). It resets on restart, but items from a prior run always have an earlier `createdAt`, which is
// the primary sort key — so the ordinal is only ever consulted within a single run.
let outboxSeqCounter = 0;
export function nextOutboxSeq(): number {
  outboxSeqCounter += 1;
  return outboxSeqCounter;
}

