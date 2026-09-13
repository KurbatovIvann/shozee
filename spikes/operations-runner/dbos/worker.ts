import { connect } from "../shared/db.js";
import { handlerFor, isScenario } from "./handlers.js";
import { DbosOperationRunner } from "./runner.js";

const databaseUrl = process.env.DBOS_SPIKE_URL;
const executorId = process.env.DBOS_SPIKE_EXECUTOR ?? "local";
const scenario = process.env.DBOS_SPIKE_SCENARIO;
const sweepEveryMs = Number(process.env.DBOS_SPIKE_SWEEP_MS ?? "0");

if (databaseUrl === undefined || !isScenario(scenario)) {
  process.stderr.write("DBOS_SPIKE_URL and a valid DBOS_SPIKE_SCENARIO are required\n");
  process.exit(2);
}

const { db, pool } = connect(databaseUrl);
const runner = new DbosOperationRunner({
  databaseUrl,
  executorId,
  workerConcurrency: 4,
  guardRecoveredAttempts: process.env.DBOS_SPIKE_UNGUARDED !== "1",
});
await runner.start(handlerFor(scenario, db));

const sweeper =
  sweepEveryMs > 0
    ? setInterval(() => {
        runner.sweep().catch((error: unknown) => process.stderr.write(`sweep failed: ${String(error)}\n`));
      }, sweepEveryMs)
    : undefined;

process.on("message", (message: unknown) => {
  if (message !== "stop") {
    return;
  }
  clearInterval(sweeper);
  const startedAt = Date.now();
  runner
    .stop()
    .then(async () => {
      await pool.end();
      process.send?.({ stopped: Date.now() - startedAt });
      process.exit(0);
    })
    .catch((error: unknown) => {
      process.stderr.write(`stop failed: ${String(error)}\n`);
      process.exit(1);
    });
});

process.send?.("ready");
