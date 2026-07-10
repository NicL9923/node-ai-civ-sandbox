import createClient from "openapi-fetch";
import type { components, paths } from "@ai-civ/federation-contracts";
import type { Clock, NonceSource, SigningCredentials } from "./signing.js";
import { HmacSigner, RandomNonceSource, SystemClock } from "./signing.js";
import type {
  RetryPolicy,
  Sleeper,
  WorldTransport,
} from "./transport.js";
import {
  defaultRetryPolicy,
  HttpWorldTransport,
  readProblem,
  sendWithRetry,
  TimerSleeper,
  WorldHttpError,
} from "./transport.js";

type RegistrationRequest = components["schemas"]["RegistrationRequest"];
type RegistrationResponse = components["schemas"]["RegistrationResponse"];
type Heartbeat = components["schemas"]["Heartbeat"];
type HeartbeatAck = components["schemas"]["HeartbeatAck"];
type EventBatch = components["schemas"]["EventBatch"];
type EventBatchResult = components["schemas"]["EventBatchResult"];
type CommandPage = components["schemas"]["CommandPage"];
type CommandAck = components["schemas"]["CommandAck"];
type CommandAckResult = components["schemas"]["CommandAckResult"];
type InteractionRequest = components["schemas"]["InteractionRequest"];
type Accepted = components["schemas"]["Accepted"];
type Interaction = components["schemas"]["Interaction"];
type PublicProjection = components["schemas"]["PublicProjection"];
type CivilizationListPage = components["schemas"]["CivilizationListPage"];
type RelationshipPage = components["schemas"]["RelationshipPage"];
type EventPage = components["schemas"]["EventPage"];
type AuthHeaders = {
  "X-Protocol-Version": "1";
  "X-Civ-Id": string;
  "X-Key-Id": string;
  "X-Timestamp": string;
  "X-Nonce": string;
  "X-Signature": string;
};

export interface SigningMutationHooks {
  beforeSign?(input: {
    credentials: SigningCredentials;
    timestamp: string;
    nonce: string;
    idempotencyKey: string;
  }): {
    credentials?: SigningCredentials;
    timestamp?: string;
    nonce?: string;
    idempotencyKey?: string;
  } | void;
  afterSign?(request: Request): Request | void;
}

export interface WorldFederationDriverOptions {
  baseUrl: string;
  credentials?: () => SigningCredentials;
  transport?: WorldTransport;
  clock?: Clock;
  nonceSource?: NonceSource;
  sleeper?: Sleeper;
  retry?: Partial<RetryPolicy>;
  signingHooks?: SigningMutationHooks;
}

type ClientResult<T> = { data?: T; error?: unknown; response: Response };

function mergeRetry(policy: Partial<RetryPolicy> | undefined): RetryPolicy {
  return { ...defaultRetryPolicy, ...policy };
}

function responseData<T>(result: ClientResult<T>): T {
  if (result.response.ok && result.data !== undefined) return result.data;
  throw new WorldHttpError(result.response.status, result.error as components["schemas"]["ProblemDetails"] | undefined);
}

export class WorldFederationDriver {
  private client: ReturnType<typeof createClient<paths>>;
  private baseUrl: string;
  private readonly transport: WorldTransport;
  private readonly clock: Clock;
  private readonly nonceSource: NonceSource;
  private readonly sleeper: Sleeper;
  private readonly retry: RetryPolicy;
  private readonly signer = new HmacSigner();
  private signingHooks?: SigningMutationHooks;

  constructor(private readonly options: WorldFederationDriverOptions) {
    this.baseUrl = options.baseUrl;
    this.transport = options.transport ?? new HttpWorldTransport();
    this.clock = options.clock ?? new SystemClock();
    this.nonceSource = options.nonceSource ?? new RandomNonceSource();
    this.sleeper = options.sleeper ?? new TimerSleeper();
    this.retry = mergeRetry(options.retry);
    this.signingHooks = options.signingHooks;
    this.client = this.createClient();
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl;
    this.client = this.createClient();
  }

  setSigningHooks(hooks?: SigningMutationHooks): void {
    this.signingHooks = hooks;
  }

  async register(body: RegistrationRequest, idempotencyKey: string): Promise<RegistrationResponse> {
    return responseData(await this.client.POST("/civilizations/register", {
      params: { header: { "Idempotency-Key": idempotencyKey } },
      body,
    }));
  }

  async heartbeat(civId: string, body: Heartbeat): Promise<HeartbeatAck> {
    return responseData(await this.client.POST("/civilizations/{civId}/heartbeat", {
      params: {
        path: { civId },
        header: this.authHeaders(),
      },
      body,
    }));
  }

  async pushEvents(civId: string, body: EventBatch, idempotencyKey: string): Promise<EventBatchResult> {
    return responseData(await this.client.POST("/civilizations/{civId}/events/batch", {
      params: {
        path: { civId },
        header: this.authHeaders(idempotencyKey),
      },
      body,
    }));
  }

  async pullCommands(civId: string, after: string | null, limit: number): Promise<CommandPage> {
    return responseData(await this.client.GET("/civilizations/{civId}/commands", {
      params: {
        path: { civId },
        query: { ...(after ? { after } : {}), limit },
        header: this.authHeaders(),
      },
    }));
  }

  async ackCommand(
    civId: string,
    commandId: string,
    body: CommandAck,
    idempotencyKey: string,
  ): Promise<CommandAckResult> {
    return responseData(await this.client.POST("/civilizations/{civId}/commands/{commandId}/ack", {
      params: {
        path: { civId, commandId },
        header: this.authHeaders(idempotencyKey),
      },
      body,
    }));
  }

  async submitInteraction(body: InteractionRequest, idempotencyKey: string): Promise<Accepted> {
    return responseData(await this.client.POST("/interactions", {
      params: { header: this.authHeaders(idempotencyKey) },
      body,
    }));
  }

  async getInteraction(interactionId: string): Promise<Interaction> {
    return responseData(await this.client.GET("/interactions/{interactionId}", {
      params: { path: { interactionId }, header: this.authHeaders() },
    }));
  }

  async listCivilizations(after?: string, limit?: number): Promise<CivilizationListPage> {
    return responseData(await this.client.GET("/civilizations", {
      params: { query: { ...(after ? { after } : {}), ...(limit ? { limit } : {}) } },
    }));
  }

  async getCivilization(civId: string): Promise<PublicProjection> {
    return responseData(await this.client.GET("/civilizations/{civId}", {
      params: { path: { civId } },
    }));
  }

  async listRelationships(
    query: { after?: string; limit?: number; civA?: string; civB?: string } = {},
  ): Promise<RelationshipPage> {
    return responseData(await this.client.GET("/relationships", { params: { query } }));
  }

  async listEvents(after?: string, limit?: number): Promise<EventPage> {
    return responseData(await this.client.GET("/events", {
      params: { query: { ...(after ? { after } : {}), ...(limit ? { limit } : {}) } },
    }));
  }

  private createClient(): ReturnType<typeof createClient<paths>> {
    return createClient<paths>({
      baseUrl: this.baseUrl,
      fetch: async (request: Request) => this.dispatch(request),
    });
  }

  private authHeaders(): AuthHeaders;
  private authHeaders(idempotencyKey: string): AuthHeaders & { "Idempotency-Key": string };
  private authHeaders(idempotencyKey?: string): AuthHeaders & { "Idempotency-Key"?: string } {
    const credentials = this.credentials();
    return {
      "X-Protocol-Version": "1",
      "X-Civ-Id": credentials.civId,
      "X-Key-Id": credentials.keyId,
      "X-Timestamp": "0",
      "X-Nonce": "serialized-by-driver",
      "X-Signature": "serialized-by-driver",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    };
  }

  private credentials(): SigningCredentials {
    if (!this.options.credentials) {
      throw new Error("Authenticated World call attempted before credentials are available");
    }
    return this.options.credentials();
  }

  private async dispatch(original: Request): Promise<Response> {
    const isRegistration = new URL(original.url).pathname.endsWith("/civilizations/register");
    const body = new Uint8Array(await original.clone().arrayBuffer());
    const headers = new Headers(original.headers);
    return sendWithRetry(
      async () => {
        if (isRegistration) {
          return new Request(original.url, {
            method: original.method,
            headers,
            body: body.length ? body : undefined,
          });
        }
        const credentials = this.credentials();
        const currentHeaders = new Headers(headers);
        const idempotencyKey = currentHeaders.get("Idempotency-Key") ?? "";
        const initial = {
          credentials,
          timestamp: Math.floor(this.clock.now().getTime() / 1_000).toString(),
          nonce: this.nonceSource.next(),
          idempotencyKey,
        };
        const mutation = this.signingHooks?.beforeSign?.(initial) ?? {};
        const signing = { ...initial, ...mutation };
        if (signing.idempotencyKey) currentHeaders.set("Idempotency-Key", signing.idempotencyKey);
        else currentHeaders.delete("Idempotency-Key");
        const url = new URL(original.url);
        const signedHeaders = this.signer.headers({
          credentials: signing.credentials,
          timestamp: signing.timestamp,
          nonce: signing.nonce,
          idempotencyKey: signing.idempotencyKey,
          method: original.method,
          path: url.pathname,
          query: url.search.slice(1),
          body,
        });
        for (const [name, value] of Object.entries(signedHeaders)) currentHeaders.set(name, value);
        const request = new Request(original.url, {
          method: original.method,
          headers: currentHeaders,
          body: body.length ? body : undefined,
        });
        return this.signingHooks?.afterSign?.(request) ?? request;
      },
      this.transport,
      this.retry,
      this.sleeper,
    );
  }
}
