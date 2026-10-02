import { createHash } from "node:crypto";

const score = (companyId: string, replica: string): string =>
  createHash("sha256").update(`${companyId}\u0000${replica}`).digest("hex");

export function shoReplicaFor(
  replicas: readonly string[],
  companyId: string,
): string {
  let chosen: string | undefined;
  let highest = "";
  for (const replica of replicas) {
    const candidate = score(companyId, replica);
    if (candidate > highest) {
      highest = candidate;
      chosen = replica;
    }
  }
  if (chosen === undefined) {
    throw new RangeError("shoReplicaFor needs at least one replica");
  }
  return chosen;
}
