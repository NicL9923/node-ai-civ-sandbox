import type { components } from "@ai-civ/federation-contracts";
import type { FakeCivilizationConfig } from "../config.js";
import type { SigningFault, SyncResult } from "../fake-civilization.js";

export type Primitive = string | number | boolean | null;

export interface ScenarioValueReference {
  valueFrom: string;
}

export type ScenarioInput<T> =
  T extends Primitive ? T | ScenarioValueReference
    : T extends Array<infer Item> ? Array<ScenarioInput<Item>>
      : T extends object ? { [Key in keyof T]: ScenarioInput<T[Key]> }
        : T;

export interface ScenarioActor {
  displayName: string;
  credentialRef: string;
  capabilities: FakeCivilizationConfig["capabilities"];
}

export interface ExpectedScenarioError {
  status?: number;
  code?: string;
}

type NetworkStepMetadata = {
  id?: string;
  saveAs?: string;
  expectError?: ExpectedScenarioError;
};

export type SocialPageInput = {
  cursor?: ScenarioInput<string>;
  limit?: number;
};

export type ReplayableScenarioStep = NetworkStepMetadata & (
  | { op: "register"; actor: string; idempotencyKey?: string }
  | { op: "heartbeat"; actor: string }
  | { op: "pushEvents"; actor: string; events: components["schemas"]["CloudEvent"][]; idempotencyKey?: string }
  | { op: "pull"; actor: string }
  | { op: "sync"; actor: string; expect?: Record<string, Primitive> }
  | { op: "ack"; actor: string; commandId: string; ack: components["schemas"]["CommandAck"]; idempotencyKey?: string }
  | { op: "submitInteraction"; actor: string; request: components["schemas"]["InteractionRequest"]; idempotencyKey?: string }
  | { op: "getInteraction"; actor: string; interactionId: string }
  | { op: "getCivilization"; actor: string; civId: string }
  | { op: "listCivilizations"; actor: string; after?: string; limit?: number }
  | { op: "listRelationships"; actor: string; query?: { after?: string; limit?: number; civA?: string; civB?: string } }
  | { op: "listEvents"; actor: string; after?: string; limit?: number }
  | { op: "syncSocialAccounts"; actor: string; body: ScenarioInput<components["schemas"]["SocialAccountSyncRequest"]>; idempotencyKey?: string }
  | { op: "getSocialAccount"; actor: string; accountId: ScenarioInput<string> }
  | ({ op: "listSocialAccountPosts"; actor: string; accountId: ScenarioInput<string> } & SocialPageInput)
  | ({ op: "listSocialFollowingFeed"; actor: string; accountId: ScenarioInput<string> } & SocialPageInput)
  | ({ op: "listSocialFollowers"; actor: string; accountId: ScenarioInput<string> } & SocialPageInput)
  | ({ op: "listSocialFollowing"; actor: string; accountId: ScenarioInput<string> } & SocialPageInput)
  | {
      op: "setSocialFollow";
      actor: string;
      accountId: ScenarioInput<string>;
      targetAccountId: ScenarioInput<string>;
      body: ScenarioInput<components["schemas"]["SocialFollowSetRequest"]>;
      idempotencyKey?: string;
    }
  | ({ op: "listSocialGlobalFeed"; actor: string } & SocialPageInput)
  | { op: "createSocialPost"; actor: string; body: ScenarioInput<components["schemas"]["SocialPostCreateRequest"]>; idempotencyKey?: string }
  | { op: "getSocialPost"; actor: string; postId: ScenarioInput<string> }
  | ({ op: "getSocialThread"; actor: string; postId: ScenarioInput<string> } & SocialPageInput)
  | {
      op: "tombstoneSocialPost";
      actor: string;
      postId: ScenarioInput<string>;
      body: ScenarioInput<components["schemas"]["SocialPostTombstoneRequest"]>;
      idempotencyKey?: string;
    }
  | {
      op: "setSocialPostLike";
      actor: string;
      postId: ScenarioInput<string>;
      accountId: ScenarioInput<string>;
      body: ScenarioInput<components["schemas"]["SocialReactionSetRequest"]>;
      idempotencyKey?: string;
    }
);

export type ScenarioStep =
  | ReplayableScenarioStep
  | { id?: string; op: "setOnline"; actor: string; online: boolean }
  | { id?: string; op: "setAuthFault"; actor: string; fault: SigningFault }
  | { id?: string; op: "replay"; stepId: string; saveAs?: string; expectError?: ExpectedScenarioError }
  | {
      id?: string;
      op: "assert";
      actual: string;
      exists?: boolean;
      equals?: ScenarioInput<Primitive>;
      contains?: ScenarioInput<Primitive>;
    }
  | { id?: string; op: "arrange"; action: string; value?: unknown };

export interface Scenario {
  schemaVersion: "1";
  name: string;
  actors: Record<string, ScenarioActor>;
  steps: ScenarioStep[];
}

export interface ScenarioHostControls {
  arrange(step: Extract<ScenarioStep, { op: "arrange" }>): Promise<void>;
}

export interface ScenarioCivilization {
  state: { online: boolean };
  register(idempotencyKey?: string): Promise<components["schemas"]["RegistrationResponse"]>;
  heartbeat(): Promise<components["schemas"]["HeartbeatAck"]>;
  pushEvents(events: components["schemas"]["CloudEvent"][], idempotencyKey?: string): Promise<components["schemas"]["EventBatchResult"]>;
  pull(): Promise<components["schemas"]["CommandPage"]>;
  sync(): Promise<SyncResult>;
  ack(commandId: string, ack: components["schemas"]["CommandAck"], idempotencyKey?: string): Promise<components["schemas"]["CommandAckResult"]>;
  submitInteraction(request: components["schemas"]["InteractionRequest"], idempotencyKey?: string): Promise<components["schemas"]["Accepted"]>;
  getInteraction(interactionId: string): Promise<components["schemas"]["Interaction"]>;
  getCivilization(civId: string): Promise<components["schemas"]["PublicProjection"]>;
  listCivilizations(after?: string, limit?: number): Promise<components["schemas"]["CivilizationListPage"]>;
  listRelationships(query?: { after?: string; limit?: number; civA?: string; civB?: string }): Promise<components["schemas"]["RelationshipPage"]>;
  listEvents(after?: string, limit?: number): Promise<components["schemas"]["EventPage"]>;
  syncSocialAccounts(body: components["schemas"]["SocialAccountSyncRequest"], idempotencyKey?: string): Promise<components["schemas"]["SocialAccountSyncResponse"]>;
  getSocialAccount(accountId: string): Promise<components["schemas"]["SocialAccount"]>;
  listSocialAccountPosts(accountId: string, query?: SocialPageInput): Promise<components["schemas"]["SocialPostPage"]>;
  listSocialFollowingFeed(accountId: string, query?: SocialPageInput): Promise<components["schemas"]["SocialPostPage"]>;
  listSocialFollowers(accountId: string, query?: SocialPageInput): Promise<components["schemas"]["SocialAccountPage"]>;
  listSocialFollowing(accountId: string, query?: SocialPageInput): Promise<components["schemas"]["SocialAccountPage"]>;
  setSocialFollow(accountId: string, targetAccountId: string, body: components["schemas"]["SocialFollowSetRequest"], idempotencyKey?: string): Promise<components["schemas"]["SocialFollow"]>;
  listSocialGlobalFeed(query?: SocialPageInput): Promise<components["schemas"]["SocialPostPage"]>;
  createSocialPost(body: components["schemas"]["SocialPostCreateRequest"], idempotencyKey?: string): Promise<components["schemas"]["SocialPost"]>;
  getSocialPost(postId: string): Promise<components["schemas"]["SocialPost"]>;
  getSocialThread(postId: string, query?: SocialPageInput): Promise<components["schemas"]["SocialThreadPage"]>;
  tombstoneSocialPost(postId: string, body: components["schemas"]["SocialPostTombstoneRequest"], idempotencyKey?: string): Promise<components["schemas"]["SocialPost"]>;
  setSocialPostLike(postId: string, accountId: string, body: components["schemas"]["SocialReactionSetRequest"], idempotencyKey?: string): Promise<components["schemas"]["SocialReaction"]>;
  setSigningFault(fault: SigningFault): void;
}

export interface ScenarioRunOptions {
  createActor(name: string, actor: ScenarioActor): ScenarioCivilization;
  hostControls?: ScenarioHostControls;
}

export interface ScenarioResult {
  name: string;
  actors: Record<string, ScenarioCivilization>;
  values: Record<string, unknown>;
  completedSteps: number;
}

export class ScenarioAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioAssertionError";
  }
}

export class ScenarioHostControlError extends Error {
  constructor() {
    super("Scenario contains arrange steps, but no ScenarioHostControls were supplied. Pure HTTP execution cannot arrange server state.");
    this.name = "ScenarioHostControlError";
  }
}

export class ScenarioDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioDefinitionError";
  }
}
