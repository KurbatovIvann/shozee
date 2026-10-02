import { serve } from "@hono/node-server";
import { createProcessLogger, loadShoServiceConfig } from "@showzy/config";

import { createShoApp } from "./app.ts";
import type { ShoEngine } from "./engine.ts";
import { createShoPool, shoDefaultWorkers } from "./pool.ts";

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

const pool = await createShoPool({
  size: config.workers ?? shoDefaultWorkers(),
  onLoss: (slot, loss) => {
    logger.warn({ slot, loss }, "sho worker replaced");
  },
  onFailure: (code, detail) => {
    logger.error({ code, frames: detail?.frames ?? null }, "sho worker failed");
  },
});
engine = pool;
logger.info(
  {
    model: pool.stamp.id,
    runtime: pool.stamp.runtime,
    workers: pool.workers,
  },
  "sho model loaded",
);

const stop = async (): Promise<void> => {
  server.close();
  await pool.dispose();
};

process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
