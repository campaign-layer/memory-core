import { createMemoryCoreFromConfig, loadConfig } from "./index.js";

const config = loadConfig();
const { app } = createMemoryCoreFromConfig(config);

const server = app.listen(config.port, config.host, () => {
  console.log(
    `[memory-core] listening on http://${config.host}:${config.port} provider=${config.providerKind}`,
  );
});

function shutdown(signal: string) {
  console.log(`[memory-core] received ${signal}, shutting down`);
  server.close((error) => {
    if (error) {
      console.error(`[memory-core] shutdown error:`, error);
      process.exit(1);
    }
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
