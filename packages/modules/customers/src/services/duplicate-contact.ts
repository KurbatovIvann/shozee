import { companyCustomers } from "@showzy/db/schema/customers";
import {
  canonicalizeEmail,
  canonicalizePhoneDigits,
} from "@showzy/validation/search";
import { and, eq, sql, type SQL } from "drizzle-orm";

import { canonicalPhoneSql } from "./canonical-phone-sql.js";
import type { WritableStaffDb } from "./writable.js";

type ContactLookupDb = Pick<WritableStaffDb, "select">;

export const DUPLICATE_PHONE_NOTE = "Клієнт з таким телефоном уже є";
export const DUPLICATE_EMAIL_NOTE = "Клієнт з таким email уже є";

async function contactTaken(
  db: ContactLookupDb,
  companyId: string,
  match: SQL,
): Promise<boolean> {
  const rows = await db
    .select({ id: companyCustomers.id })
    .from(companyCustomers)
    .where(and(eq(companyCustomers.companyId, companyId), match))
    .limit(1);
  return rows.length > 0;
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
  if (
    phone !== undefined &&
    (await contactTaken(
      db,
      companyId,
      sql`${canonicalPhoneSql(companyCustomers.phone)} = ${phone}`,
    ))
  ) {
    notes.push(DUPLICATE_PHONE_NOTE);
  }
  if (
    email !== undefined &&
    (await contactTaken(
      db,
      companyId,
      sql`lower(${companyCustomers.email}) = ${email}`,
    ))
  ) {
    notes.push(DUPLICATE_EMAIL_NOTE);
  }
  return notes;
}
