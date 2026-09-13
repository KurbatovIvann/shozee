import { and, eq, exists, lte, notExists, sql } from "drizzle-orm";

import type { SpikeDb, SpikeTx } from "../shared/db.js";
import type { OperationRef } from "../shared/port.js";
import { spikeOperations } from "../shared/schema.js";
import { pgqSignals, pgqSteps, pgqWaits } from "./schema.js";

export async function registerWaitOrReadSignal(
  tx: SpikeTx,
  operationId: string,
  name: string,
  timeoutMs: number,
): Promise<{ payload: unknown } | null> {
  await tx
    .select({ id: spikeOperations.id })
    .from(spikeOperations)
    .where(eq(spikeOperations.id, operationId))
    .for("update");
  const [signal] = await tx
    .select({ payload: pgqSignals.payload })
    .from(pgqSignals)
    .where(and(eq(pgqSignals.operationId, operationId), eq(pgqSignals.name, name)));
  if (signal) {
    return { payload: signal.payload };
  }
  await tx
    .update(spikeOperations)
    .set({ status: "waiting", revision: sql`${spikeOperations.revision} + 1` })
    .where(and(eq(spikeOperations.id, operationId), eq(spikeOperations.status, "running")));
  const timeoutAt = sql`now() + make_interval(secs => ${timeoutMs / 1000})`;
  await tx
    .insert(pgqWaits)
    .values({ operationId, name, timeoutAt })
    .onConflictDoUpdate({ target: pgqWaits.operationId, set: { name, timeoutAt } });
  return null;
}

export async function storeSignal(
  tx: SpikeTx,
  operationId: string,
  name: string,
  payload: unknown,
): Promise<OperationRef | null> {
  const [operation] = await tx
    .select({ status: spikeOperations.status, subjectId: spikeOperations.subjectId })
    .from(spikeOperations)
    .where(eq(spikeOperations.id, operationId))
    .for("update");
  if (!operation) {
    return null;
  }
  const [wait] = await tx
    .select({ name: pgqWaits.name, open: sql<boolean>`${pgqWaits.timeoutAt} > now()` })
    .from(pgqWaits)
    .where(eq(pgqWaits.operationId, operationId));
  if (wait && wait.name === name && !wait.open) {
    return null;
  }
  await tx.insert(pgqSignals).values({ operationId, name, payload }).onConflictDoNothing();
  if (operation.status !== "waiting" || wait?.name !== name) {
    return null;
  }
  return { operationId, subjectId: operation.subjectId };
}

export async function expireWaitWithoutSignal(db: SpikeDb, operationId: string): Promise<void> {
  await db
    .update(spikeOperations)
    .set({ status: "failed", revision: sql`${spikeOperations.revision} + 1` })
    .where(
      and(
        eq(spikeOperations.id, operationId),
        eq(spikeOperations.status, "waiting"),
        exists(
          db
            .select({ one: sql`1` })
            .from(pgqWaits)
            .where(
              and(
                eq(pgqWaits.operationId, operationId),
                lte(pgqWaits.timeoutAt, sql`now()`),
                notExists(
                  db
                    .select({ one: sql`1` })
                    .from(pgqSignals)
                    .where(
                      and(
                        eq(pgqSignals.operationId, pgqWaits.operationId),
                        eq(pgqSignals.name, pgqWaits.name),
                      ),
                    ),
                ),
              ),
            ),
        ),
      ),
    );
}

export async function recordStep(
  db: SpikeDb,
  operationId: string,
  key: string,
  effect: (tx: SpikeTx) => Promise<void>,
): Promise<void> {
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(pgqSteps)
      .values({ operationId, key })
      .onConflictDoNothing()
      .returning({ key: pgqSteps.key });
    if (inserted[0]) {
      await effect(tx);
    }
  });
}
