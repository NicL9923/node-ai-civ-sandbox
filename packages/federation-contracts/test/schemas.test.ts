import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { ValidateFunction } from "ajv";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const bundled = JSON.parse(
  readFileSync(resolve(pkgRoot, "openapi/world.v1.bundled.json"), "utf8"),
) as Record<string, unknown>;

// OpenAPI 3.1 schemas are JSON Schema 2020-12. We register the whole bundled
// document under the base id "world" and validate examples by $ref-ing into its
// components. `validateSchema:false` avoids meta-validating the (non-schema)
// OpenAPI root; `strict:false` ignores OpenAPI-only keywords (example, xml, ...).
const ajv = new Ajv2020({ strict: false, allErrors: true, validateSchema: false });
addFormats(ajv);
ajv.addSchema(bundled, "world");

function validatorFor(schema: string): ValidateFunction {
  return ajv.compile({ $ref: `world#/components/schemas/${schema}` });
}

function example(file: string): unknown {
  return JSON.parse(readFileSync(resolve(pkgRoot, "examples", file), "utf8"));
}

const positives: Array<[string, string]> = [
  ["RegistrationRequest", "register.request.json"],
  ["RegistrationResponse", "register.response.json"],
  ["Heartbeat", "heartbeat.request.json"],
  ["InteractionRequest", "interaction.contact.request.json"],
  ["InteractionRequest", "interaction.message.request.json"],
  ["ContactIntentData", "contact.intent.data.json"],
  ["MessageIntentData", "message.intent.data.json"],
  ["Command", "command.json"],
  ["EventBatch", "eventBatch.request.json"],
  ["CommandAck", "commandAck.request.json"],
  ["ProblemDetails", "problemDetails.json"],
];

describe("example fixtures validate against their schemas", () => {
  it.each(positives)("%s accepts %s", (schema, file) => {
    const validate = validatorFor(schema);
    const ok = validate(example(file));
    if (!ok) console.error(schema, validate.errors);
    expect(ok).toBe(true);
  });
});

describe("typed interaction payloads validate against their kind's payload schema", () => {
  it("contact request payload conforms to ContactIntentData", () => {
    const req = example("interaction.contact.request.json") as { payload: unknown };
    expect(validatorFor("ContactIntentData")(req.payload)).toBe(true);
  });

  it("message request payload conforms to MessageIntentData", () => {
    const req = example("interaction.message.request.json") as { payload: unknown };
    expect(validatorFor("MessageIntentData")(req.payload)).toBe(true);
  });
});

describe("schemas reject invalid documents", () => {
  it("RegistrationRequest requires displayName and capabilities", () => {
    const validate = validatorFor("RegistrationRequest");
    expect(validate({ onboardingToken: "onb_x" })).toBe(false);
  });

  it("InteractionRequest requires source, target, and authorityDecision", () => {
    const validate = validatorFor("InteractionRequest");
    expect(validate({ kind: "contact", source: "civ_a" })).toBe(false);
  });

  it("ProblemDetails requires the stable code field", () => {
    const validate = validatorFor("ProblemDetails");
    expect(
      validate({ type: "about:blank", title: "x", status: 400 }),
    ).toBe(false);
  });

  it("CloudEvent worldsequence must be a string int64, not a JSON number", () => {
    const validate = validatorFor("CloudEvent");
    const base = {
      id: "e1",
      specversion: "1.0",
      type: "civ.agent.acted.v1",
      source: "/civilizations/civ_a",
    };
    expect(validate({ ...base, worldsequence: "1024" })).toBe(true);
    expect(validate({ ...base, worldsequence: 1024 })).toBe(false);
  });

  it("InteractionStatus is a closed enum", () => {
    const validate = validatorFor("InteractionStatus");
    expect(validate("delivered")).toBe(true);
    expect(validate("teleported")).toBe(false);
  });

  it("InteractionKind is an open string (forward compatible)", () => {
    const validate = validatorFor("InteractionKind");
    expect(validate("contact")).toBe(true);
    // A future additive kind must NOT break existing validators.
    expect(validate("trade")).toBe(true);
  });
});
