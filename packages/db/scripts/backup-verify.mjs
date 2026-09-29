/**
 * Thin argv shim over `src/ops/backup-verify.cli.ts` (fnd-G1 A10).
 * `pnpm backup:verify` stays a plain `node scripts/...` entry; the shim
 * forwards onto Node 22 strip-types plus a `.js` → `.ts` resolve hook
 * (NodeNext specifiers) the same way the apps boot from source.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const register = pathToFileURL(
  path.join(import.meta.dirname, "ts-resolve-register.mjs"),
).href;
const cli = path.join(import.meta.dirname, "../src/ops/backup-verify.cli.ts");
const result = spawnSync(
  process.execPath,
  ["--import", register, cli, ...process.argv.slice(2)],
  { encoding: "utf8", env: process.env },
);
if (result.stdout !== null && result.stdout !== "") {
  process.stdout.write(result.stdout);
}
if (result.stderr !== null && result.stderr !== "") {
  process.stderr.write(result.stderr);
}
process.exit(result.status ?? 1);
