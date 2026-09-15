import type { ActionChannel, JobEnvelope, JobPort } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import { sql } from "drizzle-orm";
import { fromDrizzle, type PgBoss } from "pg-boss";
import { z } from "zod";

export type StoredJobData = Omit<JobEnvelope, "id" | "name">;

const actionChannels = {
  ui: "ui",
  ai: "ai",
  system: "system",
  webhook: "webhook",
} as const satisfies { readonly [K in ActionChannel]: K };

const jobActorTypes = {
  user: "user",
  system: "system",
} as const satisfies { readonly [K in JobEnvelope["actor"]["type"]]: K };

export const storedJobDataSchema = z.strictObject({
  companyId: z.string().min(1).nullable(),
  actor: z.strictObject({
    type: z.enum(jobActorTypes),
    id: z.string().min(1),
  }),
  channel: z.enum(actionChannels),
  requestId: z.string().min(1),
  correlationId: z.string().min(1),
  executionId: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
}) satisfies z.ZodType<StoredJobData>;

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
