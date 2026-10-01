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

async function takenBy(
  db: ContactLookupDb,
  companyId: string,
  match: SQL,
): Promise<string | undefined> {
  const rows = await db
    .select({ name: companyCustomers.name })
    .from(companyCustomers)
    .where(and(eq(companyCustomers.companyId, companyId), match))
    .limit(1);
  return rows[0]?.name;
}

function note(base: string, name: string, namesVisible: boolean): string {
  return namesVisible ? `${base}: ${name}` : base;
}

export async function duplicateContactNotes(
  db: ContactLookupDb,
  companyId: string,
  contact: {
    readonly phone?: string | null | undefined;
    readonly email?: string | null | undefined;
  },
  namesVisible: boolean,
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
  const phoneHolder =
    phone === undefined
      ? undefined
      : await takenBy(
          db,
          companyId,
          sql`${canonicalPhoneSql(companyCustomers.phone)} = ${phone}`,
        );
  if (phoneHolder !== undefined) {
    notes.push(note(DUPLICATE_PHONE_NOTE, phoneHolder, namesVisible));
  }
  const emailHolder =
    email === undefined
      ? undefined
      : await takenBy(
          db,
          companyId,
          sql`lower(${companyCustomers.email}) = ${email}`,
        );
  if (emailHolder !== undefined) {
    notes.push(note(DUPLICATE_EMAIL_NOTE, emailHolder, namesVisible));
  }
  return notes;
}
