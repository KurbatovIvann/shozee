/**
 * `apps/api` process entry (fnd-T26). Config is parsed once; an invalid
 * environment crashes before anything listens.
 */
import { serve } from "@hono/node-server";
import {
  createProcessLogger,
  loadServerConfig,
  s3DeviceSigningWarning,
  S3_LOOPBACK_SIGNING_WARNING,
} from "@showzy/config";

import { bootApi } from "./boot.js";
import { flushProcessObservability } from "./observability.js";
import { createProcessShutdown } from "./shutdown.js";

const config = loadServerConfig();
const logger = createProcessLogger({ name: "api-boot" });
const signingWarning = s3DeviceSigningWarning(config);
if (signingWarning !== null) {
  logger.warn(signingWarning, S3_LOOPBACK_SIGNING_WARNING);
}
const booted = await bootApi(config);

const server = serve(
  { fetch: booted.app.fetch, port: config.http.port },
  () => {
    logger.info({ port: config.http.port }, "api listening");
  },
);

function closeHttpServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

const shutdown = createProcessShutdown({
  logger,
  close: async () => {
    // Stop accepting first, then end the event streams: the server's close
    // waits for open connections, and a stream never ends on its own.
    const httpClosed = closeHttpServer();
    await booted.closeStreams();
    await httpClosed;
    await booted.close();
  },
  flush: () => flushProcessObservability(),
});

process.on("SIGINT", () => {
  void shutdown.run();
});
process.on("SIGTERM", () => {
  void shutdown.run();
});
