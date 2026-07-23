import type { components } from "@ai-civ/federation-contracts";
import { ConfigurationError, type FakeCivilizationConfig } from "./config.js";
import {
  createInitialSocialState,
  createInitialState,
  type FakeCivilizationState,
  type ProcessedCommand,
} from "./state.js";
import type { Clock, NonceSource } from "./signing.js";
import { SystemClock } from "./signing.js";
import type { Sleeper, WorldTransport } from "./transport.js";
import { defaultRetryPolicy } from "./transport.js";
import {
  WorldFederationDriver,
  type SigningMutationHooks,
  type SocialPageQuery,
} from "./world-client.js";

export interface FakeCivilizationDependencies {
  clock?: Clock;
  nonceSource?: NonceSource;
  sleeper?: Sleeper;
  transport?: WorldTransport;
  driver?: WorldFederationDriver;
  signingHooks?: SigningMutationHooks;
  state?: FakeCivilizationState;
}

export interface SyncResult {
  blockedOffline: boolean;
  pages: number;
  applied: number;
  rejected: number;
  duplicates: number;
  capped: boolean;
  cursor: string | null;
}

export type SigningFault =
  | "none"
  | "invalid-signature"
  | "stale-timestamp"
  | "reused-nonce"
  | "body-tamper"
  | "wrong-civ-id";

type Command = components["schemas"]["Command"];
type CommandAck = components["schemas"]["CommandAck"];
type CloudEvent = components["schemas"]["CloudEvent"];

export class FakeCivilization {
  readonly state: FakeCivilizationState;
  readonly driver: WorldFederationDriver;
  private readonly clock: Clock;
  private readonly baseSigningHooks?: SigningMutationHooks;

  constructor(
    readonly config: FakeCivilizationConfig,
    dependencies: FakeCivilizationDependencies = {},
  ) {
    this.clock = dependencies.clock ?? new SystemClock();
    this.baseSigningHooks = dependencies.signingHooks;
    this.state = dependencies.state ?? createInitialState(
      config.displayName,
      config.capabilities.protocolVersion,
    );
    this.state.social ??= createInitialSocialState();
    this.driver = dependencies.driver ?? new WorldFederationDriver({
      baseUrl: config.worldBaseUrl,
      transport: dependencies.transport,
      clock: this.clock,
      nonceSource: dependencies.nonceSource,
      sleeper: dependencies.sleeper,
      retry: { ...defaultRetryPolicy, ...config.retry },
      signingHooks: dependencies.signingHooks,
      credentials: () => {
        const registration = this.state.registration;
        const civId = registration?.civId ?? config.civId;
        const keyId = registration?.keyId ?? config.keyId;
        if (!civId || !keyId || !config.hmacSecret) {
          throw new ConfigurationError("Authenticated World call requires registered identity and out-of-band HMAC secret");
        }
        return { civId, keyId, secret: config.hmacSecret };
      },
    });
  }

  async register(idempotencyKey = `${this.config.alias}-register-1`): Promise<components["schemas"]["RegistrationResponse"]> {
    if (!this.config.onboardingToken) {
      throw new ConfigurationError("Registration requires an out-of-band onboarding token");
    }
    const result = await this.driver.register({
      onboardingToken: this.config.onboardingToken,
      displayName: this.config.displayName,
      capabilities: this.config.capabilities,
    }, idempotencyKey);
    this.state.registration = {
      civId: result.civId,
      keyId: result.keyId,
      protocolVersion: result.protocolVersion,
      worldBaseUrl: result.worldBaseUrl,
      registeredAt: result.registeredAt,
    };
    this.state.projection.civId = result.civId;
    this.state.projection.protocolVersion = result.protocolVersion;
    this.state.lastProcessedCommandCursor = result.commandsCursor ?? null;
    if (result.worldBaseUrl) this.driver.setBaseUrl(result.worldBaseUrl);
    return result;
  }

  async heartbeat(): Promise<components["schemas"]["HeartbeatAck"]> {
    const civId = this.requireRegistration().civId;
    this.state.projection.civId = civId;
    this.state.projection.updatedAt = this.clock.now().toISOString();
    const projection = this.state.projection as components["schemas"]["PublicProjection"];
    const acknowledgement = await this.driver.heartbeat(civId, {
      projection,
      capabilities: this.config.capabilities,
      lastProcessedWorldCursor: this.state.lastProcessedCommandCursor,
    });
    if (acknowledgement.commandsCursor != null) {
      this.state.lastProcessedCommandCursor = acknowledgement.commandsCursor;
    }
    return acknowledgement;
  }

  async pushEvents(
    events: components["schemas"]["CloudEvent"][],
    idempotencyKey?: string,
  ): Promise<components["schemas"]["EventBatchResult"]> {
    const civId = this.requireRegistration().civId;
    const key = idempotencyKey ?? `${this.config.alias}-events-${this.state.nextRequestSequence}`;
    if (!idempotencyKey) this.state.nextRequestSequence += 1;
    const result = await this.driver.pushEvents(civId, { events }, key);
    return result;
  }

  createEvent(
    type: string,
    data: CloudEvent["data"],
    idempotencyKey = `${this.config.alias}-event-${this.state.nextEventSequence}`,
  ): components["schemas"]["CloudEvent"] {
    const sequence = this.state.nextEventSequence;
    const event: components["schemas"]["CloudEvent"] = {
      id: `${this.config.alias}-evt-${sequence}`,
      specversion: "1.0",
      type,
      source: `/civilizations/${this.requireRegistration().civId}`,
      time: this.clock.now().toISOString(),
      datacontenttype: "application/json",
      data,
      idempotencykey: idempotencyKey,
    };
    this.state.nextEventSequence += 1;
    return event;
  }

  async pull(): Promise<components["schemas"]["CommandPage"]> {
    return this.driver.pullCommands(
      this.requireRegistration().civId,
      this.state.lastProcessedCommandCursor,
      this.config.pageSize ?? 50,
    );
  }

  async ack(
    commandId: string,
    ack: CommandAck,
    idempotencyKey = `${this.config.alias}-ack-${commandId}`,
  ): Promise<components["schemas"]["CommandAckResult"]> {
    return this.driver.ackCommand(this.requireRegistration().civId, commandId, ack, idempotencyKey);
  }

  async submitInteraction(
    request: components["schemas"]["InteractionRequest"],
    idempotencyKey?: string,
  ): Promise<components["schemas"]["Accepted"]> {
    const key = idempotencyKey ?? `${this.config.alias}-interaction-${this.state.nextRequestSequence}`;
    if (!idempotencyKey) this.state.nextRequestSequence += 1;
    const result = await this.driver.submitInteraction(request, key);
    return result;
  }

  setSigningFault(fault: SigningFault): void {
    if (fault === "none") {
      this.driver.setSigningHooks(this.baseSigningHooks);
      return;
    }
    const faultHooks: SigningMutationHooks = fault === "stale-timestamp"
      ? {
          beforeSign: (input) => ({
            timestamp: Math.floor((this.clock.now().getTime() - 301_000) / 1_000).toString(),
            nonce: input.nonce,
          }),
        }
      : fault === "reused-nonce"
        ? { beforeSign: () => ({ nonce: `${this.config.alias}-reused-nonce` }) }
        : fault === "wrong-civ-id"
          ? {
              beforeSign: (input) => ({
                credentials: { ...input.credentials, civId: `${input.credentials.civId}-wrong` },
              }),
            }
          : {
              afterSign: (request) => {
                const headers = new Headers(request.headers);
                if (fault === "invalid-signature") {
                  headers.set("X-Signature", "invalid-signature");
                  return new Request(request, { headers });
                }
                return new Request(request, { headers, body: "{}" });
              },
            };
    this.driver.setSigningHooks(this.combineSigningHooks(this.baseSigningHooks, faultHooks));
  }

  getInteraction(interactionId: string): Promise<components["schemas"]["Interaction"]> {
    return this.driver.getInteraction(interactionId);
  }

  getCivilization(civId: string): Promise<components["schemas"]["PublicProjection"]> {
    return this.driver.getCivilization(civId);
  }

  listCivilizations(after?: string, limit?: number): Promise<components["schemas"]["CivilizationListPage"]> {
    return this.driver.listCivilizations(after, limit);
  }

  listRelationships(query?: { after?: string; limit?: number; civA?: string; civB?: string }): Promise<components["schemas"]["RelationshipPage"]> {
    return this.driver.listRelationships(query);
  }

  listEvents(after?: string, limit?: number): Promise<components["schemas"]["EventPage"]> {
    return this.driver.listEvents(after, limit);
  }

  async syncSocialAccounts(
    body: components["schemas"]["SocialAccountSyncRequest"],
    idempotencyKey?: string,
  ): Promise<components["schemas"]["SocialAccountSyncResponse"]> {
    const result = await this.socialMutation("social-accounts", idempotencyKey, (key) =>
      this.driver.syncSocialAccounts(body, key));
    result.accounts.forEach((account, index) => {
      this.state.social.accounts[account.accountId] = account;
      const authority = body.accounts[index]?.officialAuthority;
      if (authority) this.state.social.officialAuthorities[account.accountId] = authority;
    });
    return result;
  }

  async getSocialAccount(accountId: string): Promise<components["schemas"]["SocialAccount"]> {
    const account = await this.driver.getSocialAccount(accountId);
    this.state.social.accounts[account.accountId] = account;
    return account;
  }

  async listSocialAccountPosts(
    accountId: string,
    query?: SocialPageQuery,
  ): Promise<components["schemas"]["SocialPostPage"]> {
    return this.rememberPostPage(await this.driver.listSocialAccountPosts(accountId, query));
  }

  async listSocialFollowingFeed(
    accountId: string,
    query?: SocialPageQuery,
  ): Promise<components["schemas"]["SocialPostPage"]> {
    return this.rememberPostPage(await this.driver.listSocialFollowingFeed(accountId, query));
  }

  listSocialFollowers(
    accountId: string,
    query?: SocialPageQuery,
  ): Promise<components["schemas"]["SocialAccountPage"]> {
    return this.driver.listSocialFollowers(accountId, query);
  }

  listSocialFollowing(
    accountId: string,
    query?: SocialPageQuery,
  ): Promise<components["schemas"]["SocialAccountPage"]> {
    return this.driver.listSocialFollowing(accountId, query);
  }

  async setSocialFollow(
    accountId: string,
    targetAccountId: string,
    body: components["schemas"]["SocialFollowSetRequest"],
    idempotencyKey?: string,
  ): Promise<components["schemas"]["SocialFollow"]> {
    const result = await this.socialMutation("social-follow", idempotencyKey, (key) =>
      this.driver.setSocialFollow(accountId, targetAccountId, body, key));
    this.state.social.follows[this.socialEdgeKey(result.followerAccountId, result.followedAccountId)] = result;
    return result;
  }

  async listSocialGlobalFeed(query?: SocialPageQuery): Promise<components["schemas"]["SocialPostPage"]> {
    return this.rememberPostPage(await this.driver.listSocialGlobalFeed(query));
  }

  async createSocialPost(
    body: components["schemas"]["SocialPostCreateRequest"],
    idempotencyKey?: string,
  ): Promise<components["schemas"]["SocialPost"]> {
    const post = await this.socialMutation("social-post", idempotencyKey, (key) =>
      this.driver.createSocialPost(body, key));
    return this.rememberPost(post);
  }

  async getSocialPost(postId: string): Promise<components["schemas"]["SocialPost"]> {
    return this.rememberPost(await this.driver.getSocialPost(postId));
  }

  async getSocialThread(
    postId: string,
    query?: SocialPageQuery,
  ): Promise<components["schemas"]["SocialThreadPage"]> {
    const page = await this.driver.getSocialThread(postId, query);
    page.items.forEach((post) => this.rememberPost(post));
    return page;
  }

  async tombstoneSocialPost(
    postId: string,
    body: components["schemas"]["SocialPostTombstoneRequest"],
    idempotencyKey?: string,
  ): Promise<components["schemas"]["SocialPost"]> {
    const post = await this.socialMutation("social-tombstone", idempotencyKey, (key) =>
      this.driver.tombstoneSocialPost(postId, body, key));
    return this.rememberPost(post);
  }

  async setSocialPostLike(
    postId: string,
    accountId: string,
    body: components["schemas"]["SocialReactionSetRequest"],
    idempotencyKey?: string,
  ): Promise<components["schemas"]["SocialReaction"]> {
    const result = await this.socialMutation("social-like", idempotencyKey, (key) =>
      this.driver.setSocialPostLike(postId, accountId, body, key));
    this.state.social.likes[this.socialEdgeKey(result.postId, result.accountId)] = result;
    return result;
  }

  async sync(): Promise<SyncResult> {
    if (!this.state.online) {
      return {
        blockedOffline: true,
        pages: 0,
        applied: 0,
        rejected: 0,
        duplicates: 0,
        capped: false,
        cursor: this.state.lastProcessedCommandCursor,
      };
    }
    const result: SyncResult = {
      blockedOffline: false,
      pages: 0,
      applied: 0,
      rejected: 0,
      duplicates: 0,
      capped: false,
      cursor: this.state.lastProcessedCommandCursor,
    };
    const seenCursors = new Set<string>();
    while (result.pages < (this.config.maxPages ?? 100)) {
      const startingCursor = this.state.lastProcessedCommandCursor;
      if (startingCursor) {
        if (seenCursors.has(startingCursor)) {
          throw new Error("Command cursor cycle detected");
        }
        seenCursors.add(startingCursor);
      }
      const page = await this.pull();
      for (const command of page.items) {
        const outcome = this.applyCommandOnce(command);
        const acknowledgment = await this.ack(command.commandid, this.toAck(outcome));
        if (
          acknowledgment.commandId !== command.commandid ||
          !["applied", "rejected", "duplicate"].includes(acknowledgment.status)
        ) {
          throw new Error(`World did not record a terminal ACK for command ${command.commandid}`);
        }
        if (outcome.status === "applied") result.applied += 1;
        if (outcome.status === "rejected") result.rejected += 1;
        if (outcome.status === "duplicate") result.duplicates += 1;
      }
      this.state.lastProcessedCommandCursor = page.nextCursor ?? null;
      result.cursor = this.state.lastProcessedCommandCursor;
      result.pages += 1;
      if (page.nextCursor == null) return result;
      if (seenCursors.has(page.nextCursor)) {
        throw new Error("Command cursor cycle detected");
      }
    }
    result.capped = true;
    return result;
  }

  private applyCommandOnce(command: Command): ProcessedCommand {
    const existing = this.state.processedCommands[command.commandid];
    if (existing) return existing;
    const configured = this.config.commandOutcomes?.[command.commandid] ?? this.config.commandOutcomes?.[command.type];
    let outcome: ProcessedCommand;
    if (configured === "rejected") {
      outcome = this.rejected("configured_rejection", "Command rejected by configured fake outcome");
    } else if (command.type === "world.civilization.contact.v1") {
      const data = command.data as components["schemas"]["ContactCommandData"] | undefined;
      if (!data?.interactionId || !data.fromCiv) {
        outcome = this.rejected("invalid_command_payload", "Contact command did not contain its required payload");
      } else if (configured === "applied") {
        outcome = this.applied();
      } else {
        this.state.contacts.push({
          commandId: command.commandid,
          interactionId: data.interactionId,
          fromCiv: data.fromCiv,
          greeting: data.greeting,
        });
        outcome = this.applied();
      }
    } else if (command.type === "world.civilization.message.v1") {
      const data = command.data as components["schemas"]["MessageCommandData"] | undefined;
      if (!data?.interactionId || !data.fromCiv || typeof data.body !== "string") {
        outcome = this.rejected("invalid_command_payload", "Message command did not contain its required payload");
      } else {
        this.state.messages.push({
          commandId: command.commandid,
          interactionId: data.interactionId,
          fromCiv: data.fromCiv,
          body: data.body,
          subject: data.subject,
        });
        outcome = this.applied();
      }
    } else {
      outcome = this.rejected("unsupported_command_type", `Unsupported command type: ${command.type}`);
    }
    this.state.processedCommands[command.commandid] = outcome;
    return outcome;
  }

  private applied(): ProcessedCommand {
    return { status: "applied", appliedAt: this.clock.now().toISOString() };
  }

  private rejected(code: string, detail: string): ProcessedCommand {
    return {
      status: "rejected",
      detail,
      appliedAt: this.clock.now().toISOString(),
      problem: {
        type: "about:blank",
        title: "Command rejected",
        status: 400,
        code,
        detail,
      },
    };
  }

  private toAck(outcome: ProcessedCommand): CommandAck {
    return {
      status: outcome.status,
      ...(outcome.detail ? { detail: outcome.detail } : {}),
      ...(outcome.problem ? { problem: outcome.problem } : {}),
      appliedAt: outcome.appliedAt,
    };
  }

  private combineSigningHooks(
    base: SigningMutationHooks | undefined,
    fault: SigningMutationHooks,
  ): SigningMutationHooks {
    return {
      beforeSign: (input) => {
        const baseMutation = base?.beforeSign?.(input) ?? {};
        return { ...baseMutation, ...(fault.beforeSign?.({ ...input, ...baseMutation }) ?? {}) };
      },
      afterSign: (request) => {
        const baseRequest = base?.afterSign?.(request) ?? request;
        return fault.afterSign?.(baseRequest) ?? baseRequest;
      },
    };
  }

  private requireRegistration(): NonNullable<FakeCivilizationState["registration"]> {
    if (!this.state.registration) throw new ConfigurationError("Fake civilization is not registered");
    return this.state.registration;
  }

  private async socialMutation<T>(
    operation: string,
    idempotencyKey: string | undefined,
    send: (key: string) => Promise<T>,
  ): Promise<T> {
    this.requireRegistration();
    const key = idempotencyKey ?? `${this.config.alias}-${operation}-${this.state.nextRequestSequence}`;
    if (!idempotencyKey) this.state.nextRequestSequence += 1;
    const result = await send(key);
    return result;
  }

  private rememberPost(post: components["schemas"]["SocialPost"]): components["schemas"]["SocialPost"] {
    this.state.social.posts[post.postId] = post;
    return post;
  }

  private rememberPostPage(
    page: components["schemas"]["SocialPostPage"],
  ): components["schemas"]["SocialPostPage"] {
    page.items.forEach((post) => this.rememberPost(post));
    return page;
  }

  private socialEdgeKey(left: string, right: string): string {
    return JSON.stringify([left, right]);
  }
}

export function createFakeCivilization(
  config: FakeCivilizationConfig,
  dependencies?: FakeCivilizationDependencies,
): FakeCivilization {
  return new FakeCivilization(config, dependencies);
}
