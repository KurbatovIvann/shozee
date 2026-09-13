import { sql } from "drizzle-orm";
import {
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import type { SpikeDb } from "../shared/db.js";

export const pgqSignals = pgTable(
  "spike_pgq_signals",
  {
    operationId: uuid("operation_id").notNull(),
    name: text("name").notNull(),
    payload: jsonb("payload"),
  },
  (table) => [primaryKey({ columns: [table.operationId, table.name] })],
);

export const pgqWaits = pgTable("spike_pgq_waits", {
  operationId: uuid("operation_id").primaryKey(),
  name: text("name").notNull(),
  timeoutAt: timestamp("timeout_at", { withTimezone: true }).notNull(),
});

export const pgqSteps = pgTable(
  "spike_pgq_steps",
  {
    operationId: uuid("operation_id").notNull(),
    key: text("key").notNull(),
  },
  (table) => [primaryKey({ columns: [table.operationId, table.key] })],
);

export async function installCompensationTables(db: SpikeDb): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS spike_pgq_signals (
      operation_id uuid NOT NULL,
      name text NOT NULL,
      payload jsonb,
      PRIMARY KEY (operation_id, name)
    )`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS spike_pgq_waits (
      operation_id uuid PRIMARY KEY,
      name text NOT NULL,
      timeout_at timestamptz NOT NULL
    )`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS spike_pgq_steps (
      operation_id uuid NOT NULL,
      key text NOT NULL,
      PRIMARY KEY (operation_id, key)
    )`);
}
