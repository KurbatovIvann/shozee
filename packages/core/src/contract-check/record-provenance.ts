/**
 * SHO-467: AI-exposed create actions require provenance columns on the
 * entity table they write. The required set is derived from the registry
 * (via `deriveAiToolSources`) plus the schema catalog — never a hardcoded
 * list of the nine T1 tables.
 */
import { RECORD_CREATED_VIA_CHANNELS } from "@showzy/db/schema/tenant-columns";

import { deriveAiToolSources } from "../contract/ai-exposure.js";
import { moduleOf } from "../contract/module-of.js";
import type { ActionContract } from "../contract/types.js";

/**
 * Modules whose AI-exposed creates are deliberately out of the
 * provenance-column rule. Reasons are inline so adding an entry is a
 * visible source edit, not a config/env value.
 *
 * - `companies` — the company is the tenant itself, created in onboarding;
 *   nobody vouches for it from a list.
 * - `files` — attachments, not staff records.
 */
export const RECORD_PROVENANCE_CREATE_EXCLUSIONS = Object.freeze({
  companies:
    "the company is the tenant itself, created in onboarding — nobody vouches for it from a list",
  files: "attachments, not staff records",
} as const);

/**
 * Card-level entity names that do not match the physical SQL table
 * (SHO-465). Matching still walks the schema catalog; these two aliases
 * are the known name mismatches, not the required table set.
 */
export const RECORD_PROVENANCE_PHYSICAL_TABLE_ALIASES = Object.freeze({
  customers: "company_customers",
  invites: "company_customer_invites",
} as const);

const CREATE_FROM_PREFIX = "createFrom";
const REQUIRED_COLUMNS = ["created_via", "vouched_by", "vouched_at"] as const;
const CREATED_VIA_CHECK_CHANNELS: readonly string[] =
  RECORD_CREATED_VIA_CHANNELS;

export interface SchemaColumnRef {
  readonly name: string;
  readonly notNull: boolean;
}

export interface SchemaCheckRef {
  readonly name: string;
  readonly sql: string;
}

/**
 * One Drizzle/SQL table as the contract check sees it. Composition supplies
 * the production catalog; unit tests pass fixtures.
 */
export interface SchemaTableRef {
  readonly name: string;
  readonly owner: string;
  readonly columns: readonly SchemaColumnRef[];
  readonly checks: readonly SchemaCheckRef[];
}

export interface RecordProvenanceRequirement {
  readonly action: string;
  readonly table: string;
  readonly module: string;
}

function actionVerb(name: string): string {
  const dot = name.indexOf(".");
  return dot === -1 ? name : name.slice(dot + 1);
}

function isCreateVerb(verb: string): boolean {
  return verb === "create" || /^create[A-Z]/.test(verb);
}

function isWriteRisk(contract: ActionContract): boolean {
  return contract.risk === "write" || contract.risk === "high";
}

function isExcludedModule(
  moduleName: string,
): moduleName is keyof typeof RECORD_PROVENANCE_CREATE_EXCLUSIONS {
  return moduleName in RECORD_PROVENANCE_CREATE_EXCLUSIONS;
}

function camelToSnake(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function pluralize(stem: string): string {
  if (stem.endsWith("s")) {
    return stem;
  }
  if (stem.endsWith("y") && !/[aeiou]y$/i.test(stem)) {
    return `${stem.slice(0, -1)}ies`;
  }
  return `${stem}s`;
}

/**
 * Entity stem used to find the table: bare `create` / `createFrom*` uses
 * the module name; `createCustomer` uses the remainder (`customer`).
 * Updates (`updateCustomer`, `confirm`, …) never reach here.
 */
export function entityStemForCreateAction(
  actionName: string,
): string | undefined {
  const verb = actionVerb(actionName);
  if (!isCreateVerb(verb)) {
    return undefined;
  }
  if (verb === "create") {
    return moduleOf(actionName);
  }
  if (
    verb.startsWith(CREATE_FROM_PREFIX) &&
    verb.length > CREATE_FROM_PREFIX.length &&
    verb[CREATE_FROM_PREFIX.length] ===
      verb[CREATE_FROM_PREFIX.length]?.toUpperCase()
  ) {
    return moduleOf(actionName);
  }
  const remainder = verb.slice("create".length);
  const first = remainder[0];
  if (first === undefined) {
    return moduleOf(actionName);
  }
  return camelToSnake(first.toLowerCase() + remainder.slice(1));
}

function aliasedTableName(stem: string): string | undefined {
  if (stem === "customers" || stem === "invites") {
    return RECORD_PROVENANCE_PHYSICAL_TABLE_ALIASES[stem];
  }
  const plural = pluralize(stem);
  if (plural === "customers" || plural === "invites") {
    return RECORD_PROVENANCE_PHYSICAL_TABLE_ALIASES[plural];
  }
  return undefined;
}

function resolveTable(
  stem: string,
  moduleName: string,
  tables: readonly SchemaTableRef[],
): SchemaTableRef | undefined {
  const owned = tables.filter((table) => table.owner === moduleName);
  const search = owned.length > 0 ? owned : tables;
  const preferred = aliasedTableName(stem) ?? pluralize(stem);
  const exact = search.find((table) => table.name === preferred);
  if (exact !== undefined) {
    return exact;
  }
  const plural = pluralize(stem);
  const suffixMatches = search.filter(
    (table) =>
      table.name === stem ||
      table.name === plural ||
      table.name.endsWith(`_${stem}`) ||
      table.name.endsWith(`_${plural}`) ||
      table.name.endsWith(plural),
  );
  if (suffixMatches.length === 1) {
    return suffixMatches[0];
  }
  if (suffixMatches.length > 1) {
    return suffixMatches.reduce((shortest, table) =>
      table.name.length < shortest.name.length ? table : shortest,
    );
  }
  return undefined;
}

function expectedTableName(stem: string): string {
  return aliasedTableName(stem) ?? pluralize(stem);
}

function createdViaCheckSqlIsValid(sql: string): boolean {
  return CREATED_VIA_CHECK_CHANNELS.every((channel) =>
    sql.includes(`'${channel}'`),
  );
}

function provenanceGaps(table: SchemaTableRef): string[] {
  const missing: string[] = [];
  const byName = new Map(table.columns.map((column) => [column.name, column]));
  for (const name of REQUIRED_COLUMNS) {
    const column = byName.get(name);
    if (column === undefined) {
      missing.push(name);
      continue;
    }
    if (column.notNull) {
      missing.push(`${name} (must be nullable)`);
    }
  }
  const checkName = `${table.name}_created_via_check`;
  const createdViaCheck = table.checks.find(
    (check) => check.name === checkName,
  );
  if (createdViaCheck === undefined) {
    missing.push(`${checkName} CHECK`);
  } else if (!createdViaCheckSqlIsValid(createdViaCheck.sql)) {
    missing.push(
      `${checkName} CHECK (must allow ${CREATED_VIA_CHECK_CHANNELS.join("/")})`,
    );
  }
  return missing;
}

function provenanceProblem(
  action: string,
  table: string,
  missing: readonly string[],
): string {
  return (
    `action "${action}": AI-exposed create writes table "${table}", ` +
    `which must carry nullable created_via, vouched_by and vouched_at ` +
    `plus a created_via CHECK of ${CREATED_VIA_CHECK_CHANNELS.join("|")}. ` +
    `Missing: ${missing.join(", ")}. Add them with recordProvenanceColumns() ` +
    `and recordProvenanceChecks("${table}", table) on the owning schema ` +
    `(SHO-464).`
  );
}

function missingTableProblem(
  action: string,
  moduleName: string,
  expectedTable: string,
): string {
  return (
    `action "${action}": AI-exposed create requires provenance columns ` +
    `on table "${expectedTable}", but no matching table was found in the ` +
    `schema catalog for module "${moduleName}". Add the table with ` +
    `recordProvenanceColumns() / recordProvenanceChecks(), or add ` +
    `"${moduleName}" to RECORD_PROVENANCE_CREATE_EXCLUSIONS if this ` +
    `create is a deliberate exclusion (SHO-464).`
  );
}

/**
 * AI-exposed create writes (after exclusions) and the table each one
 * requires. Used by the check and by the composition regression snapshot.
 */
export function deriveRecordProvenanceRequirements(
  contracts: readonly ActionContract[],
  schemaTables: readonly SchemaTableRef[],
): readonly RecordProvenanceRequirement[] {
  const requirements: RecordProvenanceRequirement[] = [];
  for (const contract of deriveAiToolSources(contracts)) {
    if (!isWriteRisk(contract)) {
      continue;
    }
    const moduleName = moduleOf(contract.name);
    if (isExcludedModule(moduleName)) {
      continue;
    }
    const stem = entityStemForCreateAction(contract.name);
    if (stem === undefined) {
      continue;
    }
    const table = resolveTable(stem, moduleName, schemaTables);
    requirements.push({
      action: contract.name,
      module: moduleName,
      table: table?.name ?? expectedTableName(stem),
    });
  }
  return requirements;
}

export function collectRecordProvenanceProblems(
  contracts: readonly ActionContract[],
  schemaTables: readonly SchemaTableRef[],
  problems: string[],
): void {
  const tablesByName = new Map(
    schemaTables.map((table) => [table.name, table]),
  );
  for (const contract of deriveAiToolSources(contracts)) {
    if (!isWriteRisk(contract)) {
      continue;
    }
    const moduleName = moduleOf(contract.name);
    if (isExcludedModule(moduleName)) {
      continue;
    }
    const stem = entityStemForCreateAction(contract.name);
    if (stem === undefined) {
      continue;
    }
    const table = resolveTable(stem, moduleName, schemaTables);
    if (table === undefined) {
      problems.push(
        missingTableProblem(contract.name, moduleName, expectedTableName(stem)),
      );
      continue;
    }
    const missing = provenanceGaps(tablesByName.get(table.name) ?? table);
    if (missing.length > 0) {
      problems.push(provenanceProblem(contract.name, table.name, missing));
    }
  }
}
