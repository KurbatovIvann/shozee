import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";

import * as schema from "./schema.js";

export const ADMIN_URL = "postgres://spike:spike@127.0.0.1:55432/spike";
export const REDIS_URL = "redis://127.0.0.1:56379";

export type SpikeDb = NodePgDatabase<typeof schema>;
export type SpikeTx = Parameters<Parameters<SpikeDb["transaction"]>[0]>[0];

export function databaseUrl(name: string): string {
  return `postgres://spike:spike@127.0.0.1:55432/${name}`;
}

export async function freshDatabase(name: string): Promise<string> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = databaseUrl(name);
  const { db, pool } = connect(url);
  await db.execute(sql`
    CREATE TABLE spike_operations (
      id uuid PRIMARY KEY,
      subject_id uuid NOT NULL,
      command_id uuid NOT NULL UNIQUE,
      status text NOT NULL CHECK (status IN ('queued','running','waiting','done','failed','interrupted')),
      deadline_at timestamptz,
      runs integer NOT NULL DEFAULT 0,
      revision integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await db.execute(sql`
    CREATE UNIQUE INDEX spike_operations_one_active
    ON spike_operations (subject_id)
    WHERE status IN ('queued','running','waiting')`);
  await db.execute(sql`
    CREATE TABLE spike_effects (
      id bigserial PRIMARY KEY,
      operation_id uuid NOT NULL,
      kind text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await pool.end();
  return url;
}

export function connect(url: string): { db: SpikeDb; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  return { db: drizzle(pool, { schema }), pool };
}
