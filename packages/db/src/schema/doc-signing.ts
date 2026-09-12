/**
 * Document signing requests and supplier signatures (SHO-254 / feature
 * SHO-251). Owned by the doc-signing module (ADR-0014). Deliberately
 * absent: `sign_requested_at` (documents-owned HITL grant), share
 * signed-URL columns, raw key material, signature bytes, a second
 * `signer_role` besides `supplier`, and `supplier_signed` on
 * `documents.status`.
 *
 * ON DELETE: composite FKs to `documents` and `files` are RESTRICT so a
 * signed payload cannot vanish under a request (ticket prefers RESTRICT
 * over documents-child CASCADE). `company_id → companies` stays CASCADE
 * for tenant wipe. MATCH SIMPLE skips a files FK while the payload id
 * is null — this slice keeps `payload_file_id` NOT NULL.
 */
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { documents } from "./documents.js";
import { files } from "./files.js";
import {
  tenantCompanyId,
  tenantRowUnique,
  timestampColumns,
} from "./tenant-columns.js";

/**
 * One live pending request per tenant document (partial unique). Digest
 * fields freeze the unsigned PDF for later `docSigning.complete` verify.
 */
export const signingRequests = pgTable(
  "signing_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: tenantCompanyId(),
    documentId: uuid("document_id").notNull(),
    payloadFileId: uuid("payload_file_id").notNull(),
    payloadSha256: text("payload_sha256").notNull(),
    payloadDigestAlgorithm: text("payload_digest_algorithm")
      .notNull()
      .default("sha256"),
    status: text("status").notNull().default("pending"),
    ...timestampColumns(),
  },
  (table) => [
    tenantRowUnique("signing_requests_company_id_id_uq", table),
    uniqueIndex("signing_requests_document_id_pending_uq")
      .on(table.documentId)
      .where(sql`${table.status} = 'pending'`),
    index("signing_requests_company_document_idx").on(
      table.companyId,
      table.documentId,
    ),
    index("signing_requests_payload_file_idx").on(table.payloadFileId),
    foreignKey({
      name: "signing_requests_documents_company_fk",
      columns: [table.companyId, table.documentId],
      foreignColumns: [documents.companyId, documents.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "signing_requests_payload_files_company_fk",
      columns: [table.companyId, table.payloadFileId],
      foreignColumns: [files.companyId, files.id],
    }).onDelete("restrict"),
    check(
      "signing_requests_status_check",
      sql`${table.status} IN ('pending', 'completed')`,
    ),
    check(
      "signing_requests_payload_sha256_check",
      sql`${table.payloadSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "signing_requests_payload_digest_algorithm_check",
      sql`${table.payloadDigestAlgorithm} IN ('sha256')`,
    ),
  ],
);

/**
 * Redacted supplier certificate on a recorded ASiC. Unique
 * `(document_id, signer_role)` with `signer_role` CHECK `supplier` only.
 * No raw key and no signature bytes.
 */
export const signingSignatures = pgTable(
  "signing_signatures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: tenantCompanyId(),
    documentId: uuid("document_id").notNull(),
    signerRole: text("signer_role").notNull(),
    fileId: uuid("file_id").notNull(),
    signerCn: text("signer_cn").notNull(),
    signerOrg: text("signer_org").notNull(),
    signerTaxId: text("signer_tax_id").notNull(),
    signatureAlg: text("signature_alg").notNull(),
    signedAt: timestamp("signed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    tenantRowUnique("signing_signatures_company_id_id_uq", table),
    unique("signing_signatures_document_id_signer_role_uq").on(
      table.documentId,
      table.signerRole,
    ),
    index("signing_signatures_company_document_idx").on(
      table.companyId,
      table.documentId,
    ),
    index("signing_signatures_file_idx").on(table.fileId),
    foreignKey({
      name: "signing_signatures_documents_company_fk",
      columns: [table.companyId, table.documentId],
      foreignColumns: [documents.companyId, documents.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "signing_signatures_files_company_fk",
      columns: [table.companyId, table.fileId],
      foreignColumns: [files.companyId, files.id],
    }).onDelete("restrict"),
    check(
      "signing_signatures_signer_role_check",
      sql`${table.signerRole} IN ('supplier')`,
    ),
  ],
);
