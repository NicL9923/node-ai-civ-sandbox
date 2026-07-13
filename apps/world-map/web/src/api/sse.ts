// Live world-event stream over Server-Sent Events. The World exposes GET /world/v1/stream?after=
// which first catches up from the cursor, then delivers live frames (`data: <CloudEvent>`) plus
// `: keep-alive` comments. We use fetch streaming (not EventSource) so we can resume from the last
// seen worldsequence on reconnect — preventing both gaps and duplicates — and control backoff.
import type { WorldEvent } from "./types";

export type StreamStatus = "idle" | "connecting" | "open" | "reconnecting" | "offline";

/** Pure SSE frame parser. Feed raw text chunks; get back complete data payloads. */
export class SseFrameParser {
  private buffer = "";

  /** Append a chunk, returning the `data:` payloads of any complete frames. */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const frames: string[] = [];
    let sep: number;
    // Frames are separated by a blank line (\n\n). Tolerate \r\n.
    while ((sep = this.indexOfSeparator()) !== -1) {
      const raw = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(this.separatorEnd(sep));
      const data = this.extractData(raw);
      if (data !== null) frames.push(data);
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

  /** Concatenate `data:` lines within a frame; return null for comment-only/keep-alive frames. */
  private extractData(frame: string): string | null {
    const lines = frame.split(/\r?\n/);
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith(":")) continue; // comment / keep-alive
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    return dataLines.length ? dataLines.join("\n") : null;
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
  private readonly opts: Required<Omit<EventStreamOptions, "getAfter" | "getSeqFloor">> & {
    getAfter: () => string | undefined;
    getSeqFloor: () => bigint;
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

  private dispatch(payload: string): void {
    let event: WorldEvent;
    try {
      event = JSON.parse(payload) as WorldEvent;
    } catch {
      return; // ignore malformed frame
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
