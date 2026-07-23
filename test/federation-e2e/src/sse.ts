export type SseStopReason = "matched" | "end" | "timeout" | "byte-cap" | "frame-cap" | "error";

export interface SseReadResult {
  contentType: string;
  frames: string[];
  raw: string;
  matched: boolean;
  stopReason: SseStopReason;
  error?: string;
}

export interface SseReadOptions {
  windowMs: number;
  matchFrame?: (frame: string) => boolean;
  maxBytes?: number;
  maxFrames?: number;
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
}

const DEFAULT_MAX_BYTES = 128 * 1024;
const DEFAULT_MAX_FRAMES = 500;

/**
 * Reads complete SSE frames until a predicate matches or a bounded stop condition is reached. The
 * pending buffer is drained frame-by-frame so a long replay never grows memory without bound.
 */
export async function readSseUntil(url: string, options: SseReadOptions): Promise<SseReadResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.windowMs);
  const fetchImpl = options.fetchImpl ?? ((input: string, init: RequestInit) => fetch(input, init));
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES;
  const deadlineMs = Date.now() + options.windowMs;
  const frames: string[] = [];
  const decoder = new TextDecoder();
  let contentType = "";
  let pending = "";
  let consumedBytes = 0;
  let matched = false;
  let stopReason: SseStopReason = "end";
  let error: string | undefined;

  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    });
    contentType = response.headers.get("content-type") ?? "";
    const reader = response.body?.getReader();
    if (!reader) {
      return { contentType, frames, raw: "", matched, stopReason: "end" };
    }

    try {
      while (true) {
        if (Date.now() >= deadlineMs) {
          stopReason = "timeout";
          break;
        }

        const result = await readWithAbort(reader, controller.signal, deadlineMs);
        if (result.done) {
          pending += decoder.decode();
          processFrames();
          break;
        }

        const remaining = maxBytes - consumedBytes;
        const bytes = result.value;
        const accepted = bytes.byteLength > remaining ? bytes.subarray(0, Math.max(0, remaining)) : bytes;
        consumedBytes += accepted.byteLength;
        pending += decoder.decode(accepted, { stream: true });
        processFrames();
        if (matched || stopReason !== "end") {
          break;
        }
        if (accepted.byteLength < bytes.byteLength || consumedBytes >= maxBytes) {
          stopReason = "byte-cap";
          break;
        }
      }
    } finally {
      // A non-cooperative source may never settle cancel(); initiate it but never let it hold the
      // deadline hostage. Releasing the lock is best-effort because a pending read can reject it.
      void reader.cancel().catch(() => undefined);
      try {
        reader.releaseLock();
      } catch {
        // The cancellation request above will release a pending reader once it settles.
      }
    }
  } catch (caught) {
    if (controller.signal.aborted || (caught instanceof DOMException && caught.name === "AbortError")) {
      stopReason = "timeout";
    } else {
      stopReason = "error";
      error = caught instanceof Error ? caught.message : String(caught);
    }
  } finally {
    clearTimeout(timer);
  }

  return {
    contentType,
    frames,
    raw: [...frames, pending].filter(Boolean).join("\n\n"),
    matched,
    stopReason,
    error,
  };

  function processFrames(): void {
    while (true) {
      const separator = /\r?\n\r?\n/.exec(pending);
      if (!separator || separator.index === undefined) {
        return;
      }

      const frame = pending.slice(0, separator.index);
      pending = pending.slice(separator.index + separator[0].length);
      if (!frame) {
        continue;
      }
      frames.push(frame);

      if (options.matchFrame?.(frame)) {
        matched = true;
        stopReason = "matched";
        return;
      }
      if (frames.length >= maxFrames) {
        stopReason = "frame-cap";
        return;
      }
    }
  }
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  deadlineMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const remainingMs = deadlineMs - Date.now();
  if (signal.aborted || remainingMs <= 0) {
    throw new DOMException("SSE reader timed out.", "AbortError");
  }

  return await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => finishReject(new DOMException("SSE reader timed out.", "AbortError"));

    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const finishResolve = (result: ReadableStreamReadResult<Uint8Array>) => {
      cleanup();
      resolve(result);
    };
    const finishReject = (reason: unknown) => {
      cleanup();
      reject(reason);
    };
    const onTimeout = () => finishReject(new DOMException("SSE reader timed out.", "AbortError"));

    timer = setTimeout(onTimeout, remainingMs);
    signal.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(finishResolve, finishReject);
  });
}
