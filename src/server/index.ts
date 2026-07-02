import { loadConfig } from "./config.js";
import { createAiProvider } from "./aiProvider.js";
import { EventBus } from "./eventBus.js";
import { createApp } from "./routes.js";
import { SimulationEngine } from "./simulation.js";
import { createStore } from "./store.js";

const config = loadConfig();
const store = createStore(config);
const eventBus = new EventBus();
const aiProvider = createAiProvider(config.ai);
const engine = new SimulationEngine(config, store, aiProvider, eventBus);
const app = createApp(config, engine, eventBus);

await engine.ensureSeeded();
if (config.autoStart) {
  await engine.start();
}

app.listen(config.port, () => {
  console.log(`AI civilization sandbox listening on port ${config.port}`);
  console.log(`AI provider: ${config.ai.provider}`);
});
