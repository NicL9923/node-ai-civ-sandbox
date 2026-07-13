// Dev-only world seeder. Registers a few civilizations, sends signed heartbeats, and submits
// signed contact/message interactions so the observer UI has real data to render locally.
//
// Prereq: run the World API in Development (`just world-run`) so the dev onboarding records +
// secrets in appsettings.Development.json are active. Then: `node scripts/seed-dev-world.mjs`.
//
// Signing mirrors packages/federation-contracts/test/signing.ts (the golden reference).
import { createHash, createHmac, randomUUID } from "node:crypto";

const BASE = process.env.WORLD_BASE ?? "http://localhost:5266";
const API = `${BASE}/world/v1`;
const PROTOCOL = "1"; // HmacCanonicalizer.ProtocolVersion
const PROJECTION_PROTOCOL = "1.0.0";

const UNRESERVED = /[A-Za-z0-9\-._~]/;
function rfc3986Encode(value) {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const ch = String.fromCharCode(byte);
    out += byte < 128 && UNRESERVED.test(ch) ? ch : "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}
function canonicalQuery(rawQuery) {
  if (!rawQuery) return "";
  const pairs = rawQuery
    .split("&")
    .filter((p) => p.length > 0)
    .map((pair) => {
      const eq = pair.indexOf("=");
      const k = eq >= 0 ? pair.slice(0, eq) : pair;
      const v = eq >= 0 ? pair.slice(eq + 1) : "";
      return [rfc3986Encode(decodeURIComponent(k.replace(/\+/g, " "))), rfc3986Encode(decodeURIComponent(v.replace(/\+/g, " ")))];
    });
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}
function sha256Hex(body) {
  return createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex");
}
function base64Url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function sign({ civId, keyId, timestamp, nonce, idempotencyKey, method, path, query, body }, secret) {
  const canonical = [
    PROTOCOL,
    civId,
    keyId,
    timestamp,
    nonce,
    idempotencyKey,
    method.toUpperCase(),
    path,
    canonicalQuery(query),
    sha256Hex(body),
  ].join("\n");
  return base64Url(createHmac("sha256", Buffer.from(secret, "utf8")).update(Buffer.from(canonical, "utf8")).digest());
}

async function signedPost(path, bodyObj, civ, { idempotencyKey = "" } = {}) {
  const body = JSON.stringify(bodyObj);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID().replace(/-/g, "");
  const signature = sign(
    { civId: civ.civId, keyId: civ.keyId, timestamp, nonce, idempotencyKey, method: "POST", path, query: "", body },
    civ.secret,
  );
  const headers = {
    "content-type": "application/json",
    "X-Protocol-Version": PROTOCOL,
    "X-Civ-Id": civ.civId,
    "X-Key-Id": civ.keyId,
    "X-Timestamp": timestamp,
    "X-Nonce": nonce,
    "X-Signature": signature,
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers, body });
  return res;
}

const CIVS = [
  { token: "dev-onboard-aurora", civId: "civ_aurora", keyId: "key_dev", secret: "dev-secret-aurora-0000000000000000", displayName: "Republic of Aurora", president: "Silas Vane", population: 4_200_000, treasury: 128_000 },
  { token: "dev-onboard-borealis", civId: "civ_borealis", keyId: "key_dev", secret: "dev-secret-borealis-000000000000000", displayName: "Borealis Concord", president: "Mira Holt", population: 2_750_000, treasury: 61_000 },
  { token: "dev-onboard-cinder", civId: "civ_cinder", keyId: "key_dev", secret: "dev-secret-cinder-00000000000000000", displayName: "Cinder League", president: "Rax Okonkwo", population: 6_100_000, treasury: 240_000 },
  { token: "dev-onboard-delta", civId: "civ_delta", keyId: "key_dev", secret: "dev-secret-delta-000000000000000000", displayName: "Delta Assembly", president: "Ana Perez", population: 1_100_000, treasury: 18_500 },
];

async function register(civ) {
  const res = await fetch(`${API}/civilizations/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": randomUUID() },
    body: JSON.stringify({
      onboardingToken: civ.token,
      displayName: civ.displayName,
      capabilities: { protocolVersion: PROJECTION_PROTOCOL, supportedInteractionKinds: ["contact", "message"] },
      contact: "ops@example.test",
    }),
  });
  console.log(`register ${civ.civId}: ${res.status}`);
  if (!res.ok) console.log("  " + (await res.text()));
}

async function heartbeat(civ, turn) {
  const path = `/world/v1/civilizations/${civ.civId}/heartbeat`;
  const body = {
    projection: {
      civId: civ.civId,
      displayName: civ.displayName,
      protocolVersion: PROJECTION_PROTOCOL,
      turn,
      running: true,
      population: civ.population,
      president: { ref: "leader_current", name: civ.president, title: "President", termNumber: 1 },
      economy: { treasury: civ.treasury, currency: "credits" },
      updatedAt: new Date().toISOString(),
    },
  };
  const res = await signedPost(path, body, civ);
  console.log(`heartbeat ${civ.civId}: ${res.status}`);
  if (!res.ok) console.log("  " + (await res.text()));
}

async function interact(from, to, kind, publicNarrative, payload) {
  const path = `/world/v1/interactions`;
  const body = {
    kind,
    source: from.civId,
    target: to.civId,
    authorityDecision: { mode: "president", ref: `decree_${Math.floor(Math.random() * 900 + 100)}` },
    publicNarrative,
    payload,
  };
  const res = await signedPost(path, body, from, { idempotencyKey: randomUUID() });
  console.log(`${kind} ${from.civId} -> ${to.civId}: ${res.status}`);
  if (!res.ok) console.log("  " + (await res.text()));
}

async function main() {
  console.log(`Seeding ${API} ...`);
  for (const civ of CIVS) await register(civ);
  for (const civ of CIVS) await heartbeat(civ, 40 + Math.floor(Math.random() * 10));

  const [aurora, borealis, cinder, delta] = CIVS;
  await interact(aurora, borealis, "contact", "Aurora extends a formal greeting to Borealis.", { greeting: "Greetings from Aurora.", purpose: "diplomacy" });
  await interact(borealis, aurora, "message", "Borealis welcomes Aurora's overture.", { subject: "Re: Greetings", body: "We welcome further talks." });
  await interact(cinder, delta, "contact", "Cinder issues a stern demarche to Delta.", { greeting: "Cinder demands account for border incursions.", purpose: "grievance" });
  await interact(aurora, cinder, "message", "Aurora proposes a joint trade corridor with Cinder. The corridor would run along the eastern reach, linking the two economies through a series of guarded waystations, shared customs protocols, and a jointly administered arbitration council intended to keep tariffs predictable and disputes small; both presidents have signalled cautious optimism pending review by their assemblies.", { subject: "Trade corridor", body: "Shall we open a corridor along the eastern reach?" });
  await interact(delta, borealis, "contact", "Delta seeks protection guarantees from Borealis.", { greeting: "Delta requests mutual defense talks.", purpose: "security" });

  console.log("\nDone. Interactions process asynchronously — give the World a second, then load the UI.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
