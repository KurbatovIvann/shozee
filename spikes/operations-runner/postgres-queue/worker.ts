import { isScenarioName, scenarioHandlers } from "./handlers.js";
import { PgBossOperationRunner } from "./runner.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    process.stderr.write(`missing env ${name}\n`);
    process.exit(2);
  }
  return value;
}

const handlerName = requireEnv("PGQ_HANDLER");
if (!isScenarioName(handlerName)) {
  process.stderr.write(`unknown handler ${handlerName}\n`);
  process.exit(2);
}

const runner = await PgBossOperationRunner.open({
  url: requireEnv("PGQ_URL"),
  queue: requireEnv("PGQ_QUEUE"),
  role: "worker",
  concurrency: Number(process.env.PGQ_CONCURRENCY ?? "1"),
});
await runner.start(scenarioHandlers(runner.db)[handlerName]);
process.stdout.write("ready\n");

process.on("SIGTERM", () => {
  void runner.stop().then(() => process.exit(0));
});
