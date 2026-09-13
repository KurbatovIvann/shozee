import { connect } from "../shared/db.js";
import { BullmqOperationRunner } from "./runner.js";
import { waitHandler, workHandler } from "./support.js";

function numberEnv(name: string): number {
  return Number(process.env[name] ?? "0");
}

const databaseUrl = process.env.SPIKE_DB_URL ?? "";
const queueName = process.env.SPIKE_QUEUE ?? "";
const { db, pool } = connect(databaseUrl);

const runner = new BullmqOperationRunner({
  db,
  queueName,
  claimGuard: true,
  concurrency: numberEnv("SPIKE_CONCURRENCY"),
  maxStalledCount: numberEnv("SPIKE_MAX_STALLED"),
  lockDuration: numberEnv("SPIKE_LOCK_MS"),
  stalledInterval: numberEnv("SPIKE_STALLED_MS"),
});

const handler =
  process.env.SPIKE_SCENARIO === "wait"
    ? waitHandler(db, numberEnv("SPIKE_WAIT_MS"))
    : workHandler(db, numberEnv("SPIKE_WORK_MS"));

await runner.start(handler);
process.stdout.write("ready\n");

process.on("SIGTERM", () => {
  void runner
    .dispose()
    .then(() => pool.end())
    .then(() => process.exit(0));
});
