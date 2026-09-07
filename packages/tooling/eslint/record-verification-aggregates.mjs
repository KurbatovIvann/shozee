/**
 * SHO-489: an aggregate over a provenance-carrying table is a declared
 * decision. A module file that imports drizzle `count`/`sum` and one of
 * the nine T1 provenance tables must either import
 * `@showzy/validation/record-verification` or appear in
 * `RECORD_VERIFICATION_AGGREGATE_EXEMPTIONS` with an inline reason.
 *
 * Money-shaped answers (revenue, gross by currency) exclude unvouched
 * rows; operational answers (what to cook, how many members, how many
 * price-list entries) do not (SHO-464). This rule does not fire on
 * every `count()` — only the conjunction with a provenance table.
 *
 * Paths are matched through `toPosix()` so Windows `\` and Linux `/`
 * are the same key (SHO-421 / SHO-460).
 */

const POLICY_SPEC = "@showzy/validation/record-verification";

const DRIZZLE_AGGREGATES = new Set(["count", "sum"]);

/**
 * Schema export names for the nine T1 provenance tables (SHO-465 /
 * SHO-467). SQL names are in the comment so a tenth table is a visible
 * edit here, not a guessed stem.
 *
 * company_customer_invites, company_customers, counterparties,
 * customer_groups, documents, orders, price_lists, product_variants,
 * products.
 *
 * SHO-494: this list is bound to the `recordProvenanceColumns()` call
 * sites in `packages/db/src/schema/*.ts` by the last test in
 * `record-verification-aggregates.test.mjs` — a tenth provenance table
 * fails that test until it is named here. The derivation lives in the
 * test, not in the rule: lint stays a cheap import-conjunction check.
 */
export const PROVENANCE_TABLE_EXPORTS = new Set([
  "companyCustomerInvites",
  "companyCustomers",
  "counterparties",
  "customerGroups",
  "documents",
  "orders",
  "priceLists",
  "productVariants",
  "products",
]);

/**
 * Operational aggregates that must not consult the verification policy.
 * Reasons are inline so adding an entry is a visible source edit, not a
 * config/env value — same shape as `RECORD_PROVENANCE_CREATE_EXCLUSIONS`.
 *
 * Keys are repo-relative posix paths under `packages/modules/`.
 */
export const RECORD_VERIFICATION_AGGREGATE_EXEMPTIONS = Object.freeze({
  "packages/modules/customers/src/services/count-active-members.ts":
    "operational headcount — how many active group members, not a money-shaped total",
  "packages/modules/customers/src/services/count-linked-counterparties.ts":
    "operational CRM headcount — how many linked counterparties, not revenue",
  "packages/modules/pricing/src/services/count-price-list-entries.ts":
    "operational how-many-entries on a price list, not a money-shaped total (the counted table has no provenance columns)",
  "packages/modules/catalog/src/actions/list-products.ts":
    "operational catalog page — variantCount on each product row is what to stock, not revenue",
  "packages/modules/orders/src/services/order-list/page.ts":
    "operational order page — what to cook today; per-order itemCount is not a money total. The page stays unfiltered when mode flips (SHO-464)",
});

/**
 * @param {string} filename
 */
export function toPosix(filename) {
  return filename.replaceAll("\\", "/");
}

/**
 * Repo-relative `packages/modules/...` path, or null when the file is
 * not a domain module. Separator-independent.
 *
 * @param {string} filename
 */
export function moduleSourcePath(filename) {
  const path = toPosix(filename);
  const marker = "packages/modules/";
  const index = path.indexOf(marker);
  if (index === -1) {
    return null;
  }
  return path.slice(index);
}

/**
 * @param {string} filename
 */
function isSkipped(filename) {
  const path = toPosix(filename);
  return (
    /\.db\.test\.ts$/.test(path) ||
    /\.test\.ts$/.test(path) ||
    /\.test\.mjs$/.test(path) ||
    /\/probe\/leaks\//.test(path) ||
    /\/scripts\//.test(path)
  );
}

/**
 * @param {import("estree").Node | undefined} specifier
 * @returns {string | null}
 */
function importedBindingName(specifier) {
  if (specifier === undefined || specifier.type !== "ImportSpecifier") {
    return null;
  }
  const imported = specifier.imported;
  if (imported.type === "Identifier") {
    return imported.name;
  }
  if (imported.type === "Literal" && typeof imported.value === "string") {
    return imported.value;
  }
  return null;
}

/**
 * @param {string} spec
 */
function isDrizzleOrm(spec) {
  return spec === "drizzle-orm" || spec.startsWith("drizzle-orm/");
}

/**
 * @param {string} spec
 */
function isDbSchema(spec) {
  return spec.startsWith("@showzy/db/schema/");
}

export const recordVerificationAggregatesRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "A drizzle count/sum over a provenance-carrying table must consult the verification policy or be a named exemption (SHO-489).",
    },
    schema: [],
    messages: {
      undeclaredProvenanceAggregate:
        "A drizzle count/sum over a provenance-carrying table must import @showzy/validation/record-verification or be listed in RECORD_VERIFICATION_AGGREGATE_EXEMPTIONS with an inline reason (SHO-489 / SHO-464). Money-shaped totals consult the policy; operational counts are named exemptions.",
    },
  },
  create(context) {
    if (isSkipped(context.filename)) {
      return {};
    }
    const sourcePath = moduleSourcePath(context.filename);
    if (sourcePath === null) {
      return {};
    }
    if (sourcePath in RECORD_VERIFICATION_AGGREGATE_EXEMPTIONS) {
      return {};
    }

    let hasAggregate = false;
    let hasProvenanceTable = false;
    let consultsPolicy = false;
    /** @type {import("estree").Node | null} */
    let reportNode = null;

    /**
     * @param {import("estree").Node} node
     * @param {string} spec
     */
    function visitImport(node, spec) {
      if (spec === POLICY_SPEC) {
        consultsPolicy = true;
        return;
      }
      if (!("specifiers" in node) || !Array.isArray(node.specifiers)) {
        return;
      }
      if (isDrizzleOrm(spec)) {
        for (const specifier of node.specifiers) {
          const name = importedBindingName(specifier);
          if (name !== null && DRIZZLE_AGGREGATES.has(name)) {
            hasAggregate = true;
            reportNode = node;
          }
        }
        return;
      }
      if (isDbSchema(spec)) {
        for (const specifier of node.specifiers) {
          const name = importedBindingName(specifier);
          if (name !== null && PROVENANCE_TABLE_EXPORTS.has(name)) {
            hasProvenanceTable = true;
            reportNode = node;
          }
        }
      }
    }

    return {
      ImportDeclaration(node) {
        if (typeof node.source.value === "string") {
          visitImport(node, node.source.value);
        }
      },
      ExportNamedDeclaration(node) {
        if (node.source !== null && typeof node.source.value === "string") {
          visitImport(node, node.source.value);
        }
      },
      "Program:exit"(node) {
        if (hasAggregate && hasProvenanceTable && !consultsPolicy) {
          context.report({
            node: reportNode ?? node,
            messageId: "undeclaredProvenanceAggregate",
          });
        }
      },
    };
  },
};
