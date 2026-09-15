import type { JobEnvelope, JobPort } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import { sql } from "drizzle-orm";
import { fromDrizzle, type PgBoss } from "pg-boss";

export type StoredJobData = Omit<JobEnvelope, "id" | "name">;

export function storedJobData(envelope: JobEnvelope): StoredJobData {
  return {
    companyId: envelope.companyId,
    actor: envelope.actor,
    channel: envelope.channel,
    requestId: envelope.requestId,
    correlationId: envelope.correlationId,
    executionId: envelope.executionId,
    payload: envelope.payload,
  };
}

export function createPgBossJobPort(boss: PgBoss): JobPort {
  return {
    async enqueue(tx, envelopes) {
      const db = fromDrizzle(tx, sql);
      for (const envelope of envelopes) {
        const sent = await boss.send(envelope.name, storedJobData(envelope), {
          id: envelope.id,
          db,
        });
        if (sent === null) {
          throw new CoreInvariantError(
            `job "${envelope.name}" id ${envelope.id} is still held by the runner; a second send is refused and the enqueuing transaction rolls back (SHO-681)`,
          );
        }
      }
    },
  };
}
