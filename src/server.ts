import { createMemoryCoreFromConfig, loadConfig } from "./index.js";

const config = loadConfig();
const { app, provider } = createMemoryCoreFromConfig(config);

if (config.allowInsecureListen) {
  console.warn(
    "[memory-core] WARNING: unauthenticated non-loopback listening was explicitly enabled for development",
  );
}

// Schema changes are an explicit boot phase. The listener is not opened until
// they succeed, so /ready never has to perform DDL and a fresh deployment
// cannot enter a permanent 503 loop waiting for application traffic.
if (config.providerKind === "postgres" && config.postgresAutoMigrate) {
  try {
    if (!provider.migrate) throw new Error("postgres provider does not expose migrate()");
    await provider.migrate();
  } catch (error) {
    console.error("[memory-core] startup migration failed:", error);
    await Promise.resolve(provider.close?.()).catch((closeError) => {
      console.error("[memory-core] provider close after migration failure failed:", closeError);
    });
    process.exit(1);
  }
}

const server = app.listen(config.port, config.host, () => {
  console.log(
    `[memory-core] listening on http://${config.host}:${config.port} provider=${config.providerKind}`,
  );
});

let shuttingDown = false;
let finalized = false;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const PROVIDER_CLOSE_TIMEOUT_MS = 5_000;

async function finishShutdown(exitCode: number, error?: Error) {
  if (finalized) return;
  finalized = true;
  if (error) console.error(`[memory-core] shutdown error:`, error);

  // A provider bug must not make an orchestrator wait forever after SIGTERM.
  let closeTimer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve(provider.close?.()),
      new Promise<never>((_, reject) => {
        closeTimer = setTimeout(
          () => reject(new Error(`provider close exceeded ${PROVIDER_CLOSE_TIMEOUT_MS}ms`)),
          PROVIDER_CLOSE_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (closeError) {
    console.error(`[memory-core] provider close error:`, closeError);
    exitCode = 1;
  } finally {
    if (closeTimer) clearTimeout(closeTimer);
  }
  process.exit(exitCode);
}

function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[memory-core] received ${signal}, shutting down`);

  server.closeIdleConnections?.();
  const forceTimer = setTimeout(() => {
    void finishShutdown(1, new Error(`graceful shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms`));
    server.closeAllConnections?.();
  }, SHUTDOWN_TIMEOUT_MS);

  server.close((error) => {
    clearTimeout(forceTimer);
    void finishShutdown(error ? 1 : 0, error ?? undefined);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
