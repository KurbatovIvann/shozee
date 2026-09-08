/**
 * Postgres `tsvector` customType and the name-only generated FTS
 * expression (SHO-528 / SHO-526). Schema type only — no queries.
 *
 * Staff matcher indexes live on owning domain tables. This is not
 * `schema/search.ts` and not an ADR-0020 discovery projection.
 */
import { sql, type SQL } from "drizzle-orm";
import { customType } from "drizzle-orm/pg-core";

/**
 * `tsvector` is not a first-class Drizzle column. Matcher SQL in owning
 * modules uses this type; this package still has no queries.
 */
export const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

/**
 * Generated ALWAYS STORED expression: FTS config `simple`, `setweight` A
 * on `name` only. Identifiers stay out of the vector. Do not wrap with
 * unaccent. v1 `setweight` shape only.
 */
export const nameFtsGeneratedSql: SQL = sql`setweight(to_tsvector('simple'::regconfig, coalesce("name", '')), 'A')`;

/** Owner-name generated FTS column (`name_fts`). */
export function nameFtsColumn() {
  return tsvector("name_fts").notNull().generatedAlwaysAs(nameFtsGeneratedSql);
}
