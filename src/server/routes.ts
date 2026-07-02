import path from "node:path";
import express, { type Request, type Response, type NextFunction } from "express";
import type { AppConfig } from "./config.js";
import type { EventBus } from "./eventBus.js";
import type { SimulationEngine } from "./simulation.js";

export function createApp(config: AppConfig, engine: SimulationEngine, eventBus: EventBus): express.Express {
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

  const clientRoot = path.resolve(process.cwd(), "dist/client");
  app.use(express.static(clientRoot));
  app.get(/.*/, (_request, response) => {
    response.sendFile(path.join(clientRoot, "index.html"));
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    console.error(error);
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
