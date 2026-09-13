import {
  bigserial,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const spikeOperations = pgTable("spike_operations", {
  id: uuid("id").primaryKey(),
  subjectId: uuid("subject_id").notNull(),
  commandId: uuid("command_id").notNull().unique(),
  status: text("status")
    .$type<"queued" | "running" | "waiting" | "done" | "failed" | "interrupted">()
    .notNull(),
  deadlineAt: timestamp("deadline_at", { withTimezone: true }),
  runs: integer("runs").notNull().default(0),
  revision: integer("revision").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const spikeEffects = pgTable("spike_effects", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  operationId: uuid("operation_id").notNull(),
  kind: text("kind").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
