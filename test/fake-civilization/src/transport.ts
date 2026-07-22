import type { components } from "@ai-civ/federation-contracts";

export interface WorldTransport {
  send(request: Request): Promise<Response>;
}

export interface Sleeper {
  sleep(milliseconds: number): Promise<void>;
}

export interface RetryClock {
  now(): Date;
}

export class TimerSleeper implements Sleeper {
  sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}

export interface RetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

export const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 25,
  maxDelayMs: 500,
};

export interface RequestJournalEntry {
  method: string;
  path: string;
  query: string;
  attempt: number;
  status?: number;
  error?: string;
  headers: Record<string, string>;
}

export type ProblemDetails = components["schemas"]["ProblemDetails"];

export class WorldHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly problem?: ProblemDetails,
  ) {
    super(problem?.code ?? `World request failed with ${status}`);
    this.name = "WorldHttpError";
  }
}

export class RetryExhaustedError extends Error {
  constructor(public readonly attempts: number, cause?: unknown) {
    super(`Transient World request failed after ${attempts} attempts`, { cause });
    this.name = "RetryExhaustedError";
  }
}

export class TransientTransportError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "TransientTransportError";
  }
}

export class HttpWorldTransport implements WorldTransport {
  constructor(private readonly fetchImplementation: typeof fetch = globalThis.fetch) {}

  async send(request: Request): Promise<Response> {
    try {
      return await this.fetchImplementation(request);
    } catch (error) {
      if (
        error instanceof TypeError ||
        (error instanceof DOMException && ["AbortError", "NetworkError"].includes(error.name))
      ) {
        throw new TransientTransportError("Transient World transport failure", error);
      }
      throw error;
    }
  }
}

export type ScriptedReply = Response | Error | (() => Response | Error | Promise<Response | Error>);

export interface ScriptedExpectation {
  method?: string;
  path?: string;
  query?: string;
  body?: string;
  headers?: Record<string, string>;
  reply: ScriptedReply;
}

function redactHeaders(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  headers.forEach((value, name) => {
    output[name] = /signature|authorization|token|secret/i.test(name) ? "[REDACTED]" : value;
  });
  return output;
}

export class ScriptedTransport implements WorldTransport {
  readonly journal: RequestJournalEntry[] = [];
  private readonly expectations: ScriptedExpectation[] = [];

  enqueue(expectation: ScriptedExpectation): void {
    this.expectations.push(expectation);
  }

  assertDrained(): void {
    if (this.expectations.length > 0) {
      throw new Error(`${this.expectations.length} scripted World response(s) were not consumed`);
    }
  }

  async send(request: Request): Promise<Response> {
    const expectation = this.expectations.shift();
    if (!expectation) throw new Error(`Unexpected World request ${request.method} ${new URL(request.url).pathname}`);
    const url = new URL(request.url);
    const body = await request.clone().text();
    const mismatch =
      (expectation.method && expectation.method.toUpperCase() !== request.method.toUpperCase()) ||
      (expectation.path && expectation.path !== url.pathname) ||
      (expectation.query !== undefined && expectation.query !== url.search.slice(1)) ||
      (expectation.body !== undefined && expectation.body !== body) ||
      Object.entries(expectation.headers ?? {}).some(
        ([name, value]) => request.headers.get(name) !== value,
      );
    if (mismatch) {
      throw new Error(`Scripted request mismatch for ${request.method} ${url.pathname}`);
    }
    const entry: RequestJournalEntry = {
      method: request.method,
      path: url.pathname,
      query: url.search.slice(1),
      attempt: this.journal.length + 1,
      headers: redactHeaders(request.headers),
    };
    try {
      const result = typeof expectation.reply === "function"
        ? await expectation.reply()
        : expectation.reply;
      if (result instanceof Error) throw result;
      entry.status = result.status;
      return result;
    } catch (error) {
      entry.error = error instanceof Error ? error.message : "transport failure";
      throw error;
    } finally {
      this.journal.push(entry);
    }
  }
}

export async function readProblem(response: Response): Promise<ProblemDetails | undefined> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) return undefined;
  try {
    const parsed: unknown = await response.clone().json();
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { type?: unknown }).type === "string" &&
      typeof (parsed as { title?: unknown }).title === "string" &&
      (parsed as { status?: unknown }).status === response.status &&
      typeof (parsed as { code?: unknown }).code === "string" &&
      (
        (parsed as { retryable?: unknown }).retryable === undefined ||
        typeof (parsed as { retryable?: unknown }).retryable === "boolean"
      )
    ) {
      return parsed as ProblemDetails;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function retryAfterMilliseconds(
  response: Response,
  clock: RetryClock,
  fallbackDelay: number,
): number {
  const value = response.headers.get("retry-after");
  if (!value) return fallbackDelay;
  if (/^\d+$/u.test(value.trim())) {
    return Number(value.trim()) * 1_000;
  }
  const date = Date.parse(value);
  if (Number.isNaN(date)) return fallbackDelay;
  return Math.max(0, date - clock.now().getTime());
}

function isRetryableResponse(response: Response, problem: ProblemDetails | undefined): boolean {
  if (response.status === 401 || response.status === 403) return false;
  return (
    response.status === 429 ||
    response.status >= 500 ||
    problem?.retryable === true
  );
}

export async function sendWithRetry(
  createRequest: () => Promise<Request>,
  transport: WorldTransport,
  policy: RetryPolicy,
  sleeper: Sleeper,
  clock: RetryClock = { now: () => new Date() },
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    const request = await createRequest();
    try {
      const response = await transport.send(request);
      if (response.ok) return response;
      const problem = await readProblem(response);
      if (!isRetryableResponse(response, problem)) return response;
      lastError = new WorldHttpError(response.status, problem);
      if (attempt === policy.maxAttempts) break;
      const fallbackDelay = Math.min(
        policy.maxDelayMs,
        policy.initialDelayMs * 2 ** (attempt - 1),
      );
      await sleeper.sleep(retryAfterMilliseconds(response, clock, fallbackDelay));
    } catch (error) {
      if (!(error instanceof TransientTransportError)) throw error;
      lastError = error;
      if (attempt === policy.maxAttempts) break;
      const delay = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (attempt - 1));
      await sleeper.sleep(delay);
    }
  }
  throw new RetryExhaustedError(policy.maxAttempts, lastError);
}
