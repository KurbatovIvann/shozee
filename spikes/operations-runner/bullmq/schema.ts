import { sql } from "drizzle-orm";
import {
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { connect, freshDatabase } from "../shared/db.js";

export const bullmqWaits = pgTable(
  "bullmq_waits",
  {
    operationId: uuid("operation_id").notNull(),
    name: text("name").notNull(),
    timeoutAt: timestamp("timeout_at", { withTimezone: true }).notNull(),
    payload: jsonb("payload"),
    signaledAt: timestamp("signaled_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.operationId, table.name] })],
);

export const bullmqSteps = pgTable(
  "bullmq_steps",
  {
    operationId: uuid("operation_id").notNull(),
    key: text("key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.operationId, table.key] })],
);

export const DATABASE_NAME = "spike_bullmq";

export async function prepareDatabase(): Promise<string> {
  const url = await freshDatabase(DATABASE_NAME);
  const { db, pool } = connect(url);
  await db.execute(sql`
    CREATE TABLE bullmq_waits (
      operation_id uuid NOT NULL,
      name text NOT NULL,
      timeout_at timestamptz NOT NULL,
      payload jsonb,
      signaled_at timestamptz,
      PRIMARY KEY (operation_id, name)
    )`);
  await db.execute(sql`
    CREATE TABLE bullmq_steps (
      operation_id uuid NOT NULL,
      key text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (operation_id, key)
    )`);
  await pool.end();
  return url;
}
