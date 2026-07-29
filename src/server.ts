import { createMemoryCoreFromConfig, loadConfig } from "./index.js";

const config = loadConfig();
const { app, provider } = createMemoryCoreFromConfig(config);

const server = app.listen(config.port, config.host, () => {
  console.log(
    `[memory-core] listening on http://${config.host}:${config.port} provider=${config.providerKind}`,
  );
});

let shuttingDown = false;

function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[memory-core] received ${signal}, shutting down`);

  server.close(async (error) => {
    // Release provider resources (pg pool, timers, pending writes) before exit.
    try {
      await provider.close?.();
    } catch (closeError) {
      console.error(`[memory-core] provider close error:`, closeError);
    }
    if (error) {
      console.error(`[memory-core] shutdown error:`, error);
      process.exit(1);
    }
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
