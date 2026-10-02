import type { ReadTx, Tx } from "@showzy/db";

import { CoreInvariantError } from "../errors/index.js";

export function requireWritable(
  capability: ReadTx | Tx,
  owner = "the fixture",
): Tx {
  if (!("insert" in capability)) {
    throw new CoreInvariantError(`${owner} expected the writable transaction`);
  }
  return capability;
}
