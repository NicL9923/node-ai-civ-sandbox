// Live world-event stream over Server-Sent Events. The World exposes GET /world/v1/stream?after=
// which first catches up from the cursor, then delivers live frames plus `: keep-alive` comments.
// Each event frame carries an SSE `id:` (the server's opaque resume cursor) alongside `data:`; we
// use fetch streaming (not EventSource) so we can resume from the last delivered `id:` on reconnect
// — bounding catch-up to the disconnect window — and control backoff.
import type { WorldEvent } from "./types";

export type StreamStatus = "idle" | "connecting" | "open" | "reconnecting" | "offline";

/** A parsed SSE frame: its `data:` payload plus the optional `id:` (server resume cursor). */
export interface SseFrame {
  data: string;
  id?: string;
}

/** Pure SSE frame parser. Feed raw text chunks; get back complete frames ({ data, id? }). */
export class SseFrameParser {
  private buffer = "";

  /** Append a chunk, returning any complete frames that carry a `data:` payload. */
  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    let sep: number;
    // Frames are separated by a blank line (\n\n). Tolerate \r\n.
    while ((sep = this.indexOfSeparator()) !== -1) {
      const raw = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(this.separatorEnd(sep));
      const frame = this.parseFrame(raw);
      if (frame !== null) frames.push(frame);
    }
    return frames;
  }

  private indexOfSeparator(): number {
    const a = this.buffer.indexOf("\n\n");
    const b = this.buffer.indexOf("\r\n\r\n");
    if (a === -1) return b;
    if (b === -1) return a;
    return Math.min(a, b);
  }

  private separatorEnd(sepIndex: number): number {
    return this.buffer.startsWith("\r\n\r\n", sepIndex) ? sepIndex + 4 : sepIndex + 2;
  }

  /**
   * Parse one frame's lines: concatenate `data:` lines (SSE joins with \n), take the last `id:`
   * (SSE last-wins), ignore comment lines. Returns null for comment-only / id-only frames (no data).
   */
  private parseFrame(frame: string): SseFrame | null {
    const lines = frame.split(/\r?\n/);
    const dataLines: string[] = [];
    let id: string | undefined;
    for (const line of lines) {
      if (line.startsWith(":")) continue; // comment / keep-alive
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      } else if (line.startsWith("id:")) {
        id = line.slice(3).replace(/^ /, "");
      }
    }
    if (dataLines.length === 0) return null;
    return id !== undefined ? { data: dataLines.join("\n"), id } : { data: dataLines.join("\n") };
  }
}

export interface EventStreamOptions {
  baseUrl: string;
  /**
   * Returns the current bounded opaque resume cursor to echo to the server's `after` query param,
   * read fresh on every (re)connect. The World's cursor is opaque, so we never construct one — we
   * only echo cursors the server returned (from the initial event crawl / fallback poll). Returning
   * `undefined` connects from the beginning. Because the cursor advances (via the fallback poll) and
   * the sequence floor below drops the bounded catch-up overlap, reconnects stay gap-free and
   * duplicate-free without replaying the entire history from ordinal 0.
   */
  getAfter?: () => string | undefined;
  /**
   * Returns the current sequence floor: the max worldsequence already ingested by the app (crawl +
   * poll + prior stream events). Events with `worldsequence <= floor` are dropped as catch-up
   * overlap. Read fresh per event so deliveries from crawl/poll are reflected immediately.
   */
  getSeqFloor?: () => bigint;
  onEvent: (event: WorldEvent) => void;
  /**
   * Called with a frame's opaque SSE `id:` after the frame's event parsed successfully — including
   * frames dropped as stale overlap — so the resume cursor tracks the last VALID frame seen. Never
   * called for a malformed frame (which must not poison the cursor). Frames arrive in ascending
   * order, so echoing the latest id monotonically advances the resume point to the disconnect edge.
   */
  onCursor?: (cursor: string) => void;
  onStatus: (status: StreamStatus) => void;
  fetchImpl?: typeof fetch;
  /** Backoff tuning (ms). */
  baseDelayMs?: number;
  maxDelayMs?: number;
}

function toSeq(value: string | null | undefined): bigint | null {
  if (value == null) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * Manages one live stream: connect (from the current bounded resume cursor), parse frames, drop
 * catch-up overlap via the shared sequence floor, and reconnect with exponential backoff + jitter.
 */
export class WorldEventStream {
  private readonly opts: Required<Omit<EventStreamOptions, "getAfter" | "getSeqFloor" | "onCursor">> & {
    getAfter: () => string | undefined;
    getSeqFloor: () => bigint;
    onCursor: (cursor: string) => void;
  };
  private controller: AbortController | null = null;
  private stopped = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: EventStreamOptions) {
    this.opts = {
      baseUrl: options.baseUrl,
      getAfter: options.getAfter ?? (() => undefined),
      getSeqFloor: options.getSeqFloor ?? (() => 0n),
      onCursor: options.onCursor ?? (() => {}),
      onEvent: options.onEvent,
      onStatus: options.onStatus,
      fetchImpl: options.fetchImpl ?? fetch.bind(globalThis),
      baseDelayMs: options.baseDelayMs ?? 1000,
      maxDelayMs: options.maxDelayMs ?? 30_000,
    };
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    this.controller = null;
    this.opts.onStatus("idle");
  }

  private backoffDelay(): number {
    const exp = Math.min(this.opts.maxDelayMs, this.opts.baseDelayMs * 2 ** this.attempt);
    const jitter = exp * (0.8 + Math.random() * 0.4); // ±20%
    return Math.round(jitter);
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.opts.onStatus("reconnecting");
    const delay = this.backoffDelay();
    this.attempt += 1;
    this.timer = setTimeout(() => void this.connect(), delay);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.controller = new AbortController();
    this.opts.onStatus(this.attempt === 0 ? "connecting" : "reconnecting");

    const after = this.opts.getAfter();
    const url = after
      ? `${this.opts.baseUrl}/stream?after=${encodeURIComponent(after)}`
      : `${this.opts.baseUrl}/stream`;
    try {
      const res = await this.opts.fetchImpl(url, {
        headers: { Accept: "text/event-stream" },
        signal: this.controller.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`stream responded ${res.status}`);
      }

      this.opts.onStatus("open");
      this.attempt = 0; // successful connect resets backoff

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseFrameParser();

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const frames = parser.push(decoder.decode(value, { stream: true }));
        for (const frame of frames) this.dispatch(frame);
      }
      // Stream ended cleanly (server closed) — reconnect to resume.
      if (!this.stopped) this.scheduleReconnect();
    } catch (err) {
      if (this.stopped || (err instanceof DOMException && err.name === "AbortError")) return;
      this.opts.onStatus("offline");
      this.scheduleReconnect();
    }
  }

  private dispatch(frame: SseFrame): void {
    let event: WorldEvent;
    try {
      event = JSON.parse(frame.data) as WorldEvent;
    } catch {
      return; // malformed frame: ignore and do NOT advance the cursor (must not poison resume)
    }

    // The frame parsed to a valid event. Advance the resume cursor to this frame's server `id:`
    // (even if we drop the event below as stale overlap) so a reconnect resumes from here, bounding
    // catch-up to the disconnect window. Frames arrive in ascending order, so this is monotonic.
    if (frame.id !== undefined) {
      this.opts.onCursor(frame.id);
    }

    const seq = toSeq(event.worldsequence);
    // Drop bounded catch-up overlap using the shared floor (a decimal STRING compared as BigInt,
    // so sequences beyond 2^53 stay correct). Events with an unparseable/missing sequence are
    // delivered and deduped downstream by id.
    if (seq !== null && seq <= this.opts.getSeqFloor()) {
      return;
    }
    this.opts.onEvent(event);
  }
}
