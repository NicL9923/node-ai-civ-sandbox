import { loadConfig } from "./config.js";
import { createAiProvider } from "./aiProvider.js";
import { EventBus } from "./eventBus.js";
import { createApp } from "./routes.js";
import { SimulationEngine } from "./simulation.js";
import { createStore } from "./store.js";
import { initTelemetry } from "./telemetry.js";
import { FederationService } from "./world/federationService.js";
import { FederationConnector } from "./world/federationConnector.js";

const config = loadConfig();
initTelemetry(config.telemetry.connectionString);
const store = createStore(config);
const eventBus = new EventBus();
const aiProvider = createAiProvider(config.ai);

// Optional World federation. When config.federation is undefined the app runs as a standalone civ and
// none of this is constructed — the engine simply has no federation port.
const federationService = config.federation
  ? new FederationService(store, config.federation, eventBus, config.simulationId)
  : undefined;
const federationConnector = config.federation && federationService
  ? new FederationConnector(federationService, config.federation)
  : undefined;

const engine = new SimulationEngine(config, store, aiProvider, eventBus, federationService);
const app = createApp(config, engine, eventBus, federationService, federationConnector);

await engine.ensureSeeded();
if (config.autoStart) {
  await engine.start();
}

if (federationConnector) {
  await federationConnector.start();
  console.log("World federation connector started.");
}

const server = app.listen(config.port, () => {
  console.log(`AI civilization sandbox listening on port ${config.port}`);
  console.log(`AI provider: ${config.ai.provider}`);
});

// Graceful shutdown: stop the connector and the turn timer WITHOUT persisting a pause, so a restart
// resumes the prior running state.
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down.`);
  federationConnector?.stop();
  engine.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
