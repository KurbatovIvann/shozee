import { serve } from "@hono/node-server";
import { createProcessLogger, loadShoServiceConfig } from "@showzy/config";

import { createShoApp } from "./app.ts";
import { loadShoEngine, type ShoEngine } from "./engine.ts";

const config = loadShoServiceConfig();
const logger = createProcessLogger({ name: "sho-boot" });

let engine: ShoEngine | null = null;

const server = serve(
  {
    fetch: createShoApp({
      serviceToken: config.serviceToken,
      engine: () => engine,
      log: (entry) => {
        logger.info(entry, "sho parse");
      },
    }).fetch,
    port: config.port,
  },
  () => {
    logger.info({ port: config.port }, "sho listening");
  },
);

engine = await loadShoEngine();
logger.info(
  { model: engine.stamp.id, runtime: engine.stamp.runtime },
  "sho model loaded",
);

const stop = async (): Promise<void> => {
  server.close();
  await engine.dispose();
};

process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
