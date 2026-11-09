import { createAppServices } from "./container.js";
import { createHttpApp } from "./transport/http.js";
import { logger } from "./utils/logger.js";
import { SERVER_NAME, SERVER_VERSION } from "./server.js";

async function main(): Promise<void> {
  const services = createAppServices();
  const { config, db } = services;

  const app = createHttpApp(services);
  app.server.listen(config.port, config.host, () => {
    logger.info(
      {
        name: SERVER_NAME,
        version: SERVER_VERSION,
        bind: `http://${config.host}:${config.port}`,
        mcp: `http://${config.host}:${config.port}/mcp`,
        data_dir: config.dataDir,
        exec_mode: config.execMode,
      },
      "universal-workspace-mcp listening"
    );
    // eslint-disable-next-line no-console
    console.log(`\n🚀 Universal Workspace MCP ready`);
    console.log(`   Local:  http://${config.host}:${config.port}/mcp`);
    console.log(`   Health: http://${config.host}:${config.port}/health`);
    console.log(`   Data:   ${config.dataDir}\n`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    const force = setTimeout(() => process.exit(1), 5_000);
    force.unref();
    app
      .close()
      .then(() => {
        db.close();
        logger.info("shutdown complete");
        process.exit(0);
      })
      .catch((error) => {
        logger.error({ err: error }, "error during shutdown");
        process.exit(1);
      });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("fatal startup error:", error instanceof Error ? error.message : error);
  process.exit(1);
});
