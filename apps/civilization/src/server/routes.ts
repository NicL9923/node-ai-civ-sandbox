import path from "node:path";
import express, { type Request, type Response, type NextFunction } from "express";
import { z, ZodError } from "zod";
import type { AppConfig } from "./config.js";
import type { EventBus } from "./eventBus.js";
import type { SimulationEngine } from "./simulation.js";
import type { FederationService } from "./world/federationService.js";
import type { FederationConnector } from "./world/federationConnector.js";
import type { SocialService } from "./world/socialService.js";

const positionSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0)
});

const textListSchema = z.array(z.string().trim().min(1).max(800)).max(30);

const agentCreateSchema = z.object({
  id: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/).optional(),
  name: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(120),
  active: z.boolean().optional(),
  position: positionSchema.optional(),
  voice: z.string().trim().min(1).max(600).optional(),
  corePrinciples: textListSchema.optional(),
  personalityTraits: textListSchema.optional(),
  beliefs: textListSchema.optional(),
  goals: textListSchema.optional(),
  memorySummaries: textListSchema.optional()
});

const agentUpdateSchema = agentCreateSchema.partial().omit({ id: true });

export function createApp(
  config: AppConfig,
  engine: SimulationEngine,
  eventBus: EventBus,
  federationService?: FederationService,
  federationConnector?: FederationConnector,
  socialService?: SocialService
): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "512kb" }));

  app.get("/healthz", (_request, response) => {
    response.json({ ok: true });
  });

  app.get("/api/world", asyncHandler(async (_request, response) => {
    response.json(await engine.snapshot());
  }));

  app.get("/api/constitution/current", asyncHandler(async (_request, response) => {
    response.json((await engine.snapshot()).currentConstitution);
  }));

  app.get("/api/constitution/history", asyncHandler(async (_request, response) => {
    response.json((await engine.snapshot()).constitutionHistory);
  }));

  app.get("/api/events/recent", asyncHandler(async (_request, response) => {
    response.json((await engine.snapshot()).recentEvents);
  }));

  app.get("/api/stream", (request, response) => {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    response.write(": connected\n\n");
    eventBus.addClient(response);
    request.on("close", () => response.end());
  });

  app.post("/api/admin/start", requireAdmin(config), asyncHandler(async (_request, response) => {
    await engine.start();
    response.json({ ok: true, running: true });
  }));

  app.post("/api/admin/pause", requireAdmin(config), asyncHandler(async (_request, response) => {
    await engine.pause();
    response.json({ ok: true, running: false });
  }));

  app.post("/api/admin/reset", requireAdmin(config), asyncHandler(async (_request, response) => {
    await engine.reset();
    response.json({ ok: true });
  }));

  app.post("/api/admin/seed", requireAdmin(config), asyncHandler(async (_request, response) => {
    await engine.ensureSeeded();
    response.json({ ok: true });
  }));

  app.get("/api/admin/models", requireAdmin(config), asyncHandler(async (_request, response) => {
    response.json({
      deployments: engine.supportedModels(),
      note: "Agent model values map through this object when present; otherwise the model value is treated as the deployment name."
    });
  }));

  app.get("/api/admin/agents", requireAdmin(config), asyncHandler(async (_request, response) => {
    response.json((await engine.snapshot()).agents);
  }));

  app.post("/api/admin/agents", requireAdmin(config), asyncHandler(async (request, response) => {
    const agent = await engine.addAgent(agentCreateSchema.parse(request.body));
    response.status(201).json(agent);
  }));

  app.patch("/api/admin/agents/:agentId", requireAdmin(config), asyncHandler(async (request, response) => {
    response.json(await engine.updateAgent(requiredParam(request, "agentId"), agentUpdateSchema.parse(request.body)));
  }));

  app.post("/api/admin/agents/:agentId/activate", requireAdmin(config), asyncHandler(async (request, response) => {
    response.json(await engine.updateAgent(requiredParam(request, "agentId"), { active: true }));
  }));

  app.post("/api/admin/agents/:agentId/deactivate", requireAdmin(config), asyncHandler(async (request, response) => {
    response.json(await engine.updateAgent(requiredParam(request, "agentId"), { active: false }));
  }));

  // Federation diagnostics (admin only). These never echo the HMAC secret, key material, or onboarding
  // token. When the connector is not configured they report a disabled status rather than 404-ing.
  app.get("/api/admin/federation/status", requireAdmin(config), asyncHandler(async (_request, response) => {
    if (!federationService) {
      response.json({ enabled: false });
      return;
    }
    response.json(await federationService.getSnapshot());
  }));

  app.post("/api/admin/federation/register", requireAdmin(config), asyncHandler(async (_request, response) => {
    if (!federationConnector || !federationService) {
      response.status(409).json({ error: "Federation is not enabled." });
      return;
    }
    await federationConnector.register();
    const snapshot = await federationService.getSnapshot();
    response.json({ ok: true, registered: snapshot.registered, civId: snapshot.civId });
  }));

  app.post("/api/admin/federation/heartbeat", requireAdmin(config), asyncHandler(async (_request, response) => {
    if (!federationConnector) {
      response.status(409).json({ error: "Federation is not enabled." });
      return;
    }
    await federationConnector.heartbeat();
    response.json({ ok: true });
  }));

  app.post("/api/admin/federation/sync", requireAdmin(config), asyncHandler(async (_request, response) => {
    if (!federationConnector) {
      response.status(409).json({ error: "Federation is not enabled." });
      return;
    }
    await federationConnector.pollAndAck();
    await federationConnector.flushOutbox();
    response.json({ ok: true });
  }));

  // World Wire (social) diagnostics (admin only). The snapshot is citizen-safe: it never echoes the HMAC
  // secret, key material, onboarding token, President term authority, or any private agent data.
  app.get("/api/admin/federation/social", requireAdmin(config), asyncHandler(async (_request, response) => {
    if (!socialService) {
      response.status(409).json({ error: "World Wire is not enabled." });
      return;
    }
    response.json(await socialService.getSnapshot());
  }));

  // Force a social account-sync + feed refresh + outbox flush (admin only).
  app.post("/api/admin/federation/social/sync", requireAdmin(config), asyncHandler(async (_request, response) => {
    if (!federationConnector || !socialService) {
      response.status(409).json({ error: "World Wire is not enabled." });
      return;
    }
    await federationConnector.syncSocialAccounts();
    await federationConnector.pollSocialFeed();
    await federationConnector.flushOutbox();
    response.json(await socialService.getSnapshot());
  }));

  const clientRoot = path.resolve(process.cwd(), "dist/client");
  app.use(express.static(clientRoot));
  app.get(/.*/, (_request, response) => {
    response.sendFile(path.join(clientRoot, "index.html"));
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    console.error(error);
    if (error instanceof ZodError) {
      response.status(400).json({
        error: "Invalid request body.",
        issues: error.issues
      });
      return;
    }

    response.status(500).json({
      error: error instanceof Error ? error.message : "Unexpected server error"
    });
  });

  setInterval(() => eventBus.heartbeat(), 25_000).unref();
  return app;
}

function requireAdmin(config: AppConfig) {
  return (request: Request, response: Response, next: NextFunction) => {
    if (!config.adminApiKey) {
      response.status(503).json({ error: "ADMIN_API_KEY is not configured." });
      return;
    }

    const provided = request.header("x-admin-key");
    if (provided !== config.adminApiKey) {
      response.status(401).json({ error: "Invalid admin key." });
      return;
    }

    next();
  };
}

function asyncHandler(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction) => {
    handler(request, response).catch(next);
  };
}

function requiredParam(request: Request, name: string): string {
  const value = request.params[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required route parameter '${name}'.`);
  }
  return value;
}
