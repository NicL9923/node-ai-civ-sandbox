import { type ChildProcess, spawn } from "node:child_process";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";

/** Allocate a free loopback TCP port by binding to :0 and reading the assigned port back. */
export async function allocatePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("Failed to allocate a port"))));
    });
  });
}

/**
 * A bounded, redacting ring buffer for a child process's stdout/stderr. Raw secret values are
 * replaced before anything is retained, and only a small tail is ever emitted on failure so no
 * unredacted diagnostics escape.
 */
export class RedactingLog {
  private readonly lines: string[] = [];

  constructor(
    private readonly name: string,
    private readonly secrets: string[],
    private readonly max = 250,
  ) {}

  redact(text: string): string {
    let out = text;
    for (const secret of this.secrets) {
      if (secret && secret.length >= 6) {
        out = out.split(secret).join("[REDACTED]");
      }
    }
    return out;
  }

  push(chunk: Buffer | string): void {
    const text = this.redact(chunk.toString());
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trimEnd();
      if (!line) continue;
      this.lines.push(`[${this.name}] ${line}`);
      if (this.lines.length > this.max) this.lines.shift();
    }
  }

  tail(count = 60): string {
    return this.lines.slice(-count).join("\n");
  }
}

export interface ManagedProcess {
  child: ChildProcess;
  log: RedactingLog;
  readonly pid: number | undefined;
}

export interface SpawnOptions {
  name: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  secrets: string[];
}

export function spawnManaged(options: SpawnOptions): ManagedProcess {
  const log = new RedactingLog(options.name, options.secrets);
  const child = spawn(options.command, options.args, {
    env: options.env,
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.on("data", (chunk) => log.push(chunk));
  child.stderr?.on("data", (chunk) => log.push(chunk));
  child.on("error", (error) => log.push(`spawn error: ${error.message}`));
  return { child, log, get pid() { return child.pid; } };
}

/** Fetch with an abortable per-attempt timeout; never throws, returns null on any failure. */
async function tryFetch(
  url: string,
  init: RequestInit,
  perAttemptMs: number,
): Promise<{ status: number; body: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), perAttemptMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.text();
    return { status: response.status, body };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Poll a URL until `predicate` accepts the response or the monotonic deadline passes. Uses
 * condition polling (never a fixed sleep) with abortable requests.
 */
export async function waitForHttp(
  url: string,
  predicate: (status: number, body: string) => boolean,
  options: { timeoutMs?: number; intervalMs?: number; init?: RequestInit; label?: string } = {},
): Promise<{ status: number; body: string }> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let last: { status: number; body: string } | null = null;
  while (Date.now() < deadline) {
    last = await tryFetch(url, options.init ?? {}, Math.min(5_000, intervalMs + 4_000));
    if (last && predicate(last.status, last.body)) return last;
    await delay(intervalMs);
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${options.label ?? url}` +
      (last ? ` (last status ${last.status})` : " (no response)"),
  );
}

/** Generic deadline-bounded condition poller for asynchronous world processing. */
export async function pollUntil<T>(
  produce: () => Promise<T>,
  accept: (value: T) => boolean,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 300;
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      last = await produce();
      if (accept(last)) return last;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  const detail = lastError instanceof Error ? ` (last error: ${lastError.message})` : "";
  throw new Error(`Timed out after ${timeoutMs}ms polling for ${options.label ?? "condition"}${detail}`);
}

/** Best-effort graceful stop, then force-terminate only this recorded child after a short deadline. */
export async function stopManaged(process: ManagedProcess | undefined, graceMs = 4_000): Promise<void> {
  if (!process?.child || process.child.exitCode !== null || process.child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => process.child.once("exit", () => resolve()));
  try {
    process.child.kill("SIGINT");
  } catch {
    // ignore — fall through to force kill
  }
  const raced = await Promise.race([
    exited.then(() => "exited" as const),
    delay(graceMs).then(() => "timeout" as const),
  ]);
  if (raced === "timeout") {
    try {
      process.child.kill("SIGKILL");
    } catch {
      // ignore
    }
    await Promise.race([exited, delay(2_000)]);
  }
}
