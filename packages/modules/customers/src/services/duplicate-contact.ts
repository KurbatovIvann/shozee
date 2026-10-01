import { companyCustomers } from "@showzy/db/schema/customers";
import {
  canonicalizeEmail,
  canonicalizePhoneDigits,
} from "@showzy/validation/search";
import { and, eq, sql, type SQL } from "drizzle-orm";

import { canonicalPhoneSql } from "./canonical-phone-sql.js";
import type { WritableStaffDb } from "./writable.js";

type ContactLookupDb = Pick<WritableStaffDb, "select">;

export const DUPLICATE_PHONE_NOTE_PREFIX = "Клієнт з таким телефоном уже є: ";
export const DUPLICATE_EMAIL_NOTE_PREFIX = "Клієнт з таким email уже є: ";

async function firstMatchingName(
  db: ContactLookupDb,
  companyId: string,
  match: SQL,
): Promise<string | undefined> {
  const rows = await db
    .select({ name: companyCustomers.name })
    .from(companyCustomers)
    .where(and(eq(companyCustomers.companyId, companyId), match))
    .orderBy(companyCustomers.name, companyCustomers.id)
    .limit(1);
  return rows[0]?.name;
}

export async function duplicateContactNotes(
  db: ContactLookupDb,
  companyId: string,
  contact: {
    readonly phone?: string | null | undefined;
    readonly email?: string | null | undefined;
  },
): Promise<string[]> {
  const phone =
    contact.phone === null || contact.phone === undefined
      ? undefined
      : canonicalizePhoneDigits(contact.phone);
  const email =
    contact.email === null || contact.email === undefined
      ? undefined
      : canonicalizeEmail(contact.email);
  const notes: string[] = [];
  if (phone !== undefined) {
    const name = await firstMatchingName(
      db,
      companyId,
      sql`${canonicalPhoneSql(companyCustomers.phone)} = ${phone}`,
    );
    if (name !== undefined) {
      notes.push(`${DUPLICATE_PHONE_NOTE_PREFIX}${name}`);
    }
  }
  if (email !== undefined) {
    const name = await firstMatchingName(
      db,
      companyId,
      sql`lower(${companyCustomers.email}) = ${email}`,
    );
    if (name !== undefined) {
      notes.push(`${DUPLICATE_EMAIL_NOTE_PREFIX}${name}`);
    }
  }
  return notes;
}
