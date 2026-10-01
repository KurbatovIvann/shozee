import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

export function canonicalPhoneSql(phone: SQLWrapper): SQL {
  const digits = sql`regexp_replace(coalesce(${phone}, ''), '[^0-9]', '', 'g')`;
  return sql`(CASE WHEN ${digits} LIKE '0%' THEN '380' || substr(${digits}, 2) ELSE ${digits} END)`;
}
