import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";

import {
  RECORD_VERIFICATION_AGGREGATE_EXEMPTIONS,
  moduleSourcePath,
  recordVerificationAggregatesRule,
  toPosix,
} from "./record-verification-aggregates.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

/**
 * @param {string} relative
 */
function file(relative) {
  return path.join(repoRoot, relative);
}

const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
  },
});

const UNDECLARED_AGGREGATE = `
  import { orders } from "@showzy/db/schema/orders";
  import { count } from "drizzle-orm";
  export const total = count();
`;

const CONSULTING_AGGREGATE = `
  import { orders } from "@showzy/db/schema/orders";
  import { recordCountsSql } from "@showzy/validation/record-verification";
  import { count } from "drizzle-orm";
  export const total = count();
  export const predicate = recordCountsSql;
`;

test("toPosix is identical on Windows and Linux separators", () => {
  const posix = "packages/modules/orders/src/services/order-list/aggregate.ts";
  const windows = posix.replaceAll("/", "\\");
  assert.equal(toPosix(windows), posix);
  assert.equal(toPosix(posix), posix);
  assert.equal(toPosix(`C:\\repo\\${windows}`), `C:/repo/${posix}`);
});

test("moduleSourcePath matches exemption keys without depending on separators", () => {
  const relative =
    "packages/modules/customers/src/services/count-active-members.ts";
  assert.equal(moduleSourcePath(relative), relative);
  assert.equal(moduleSourcePath(relative.replaceAll("/", "\\")), relative);
  assert.equal(
    moduleSourcePath(`D:\\work\\showzy-v2\\${relative.replaceAll("/", "\\")}`),
    relative,
  );
  assert.equal(moduleSourcePath("packages/tooling/eslint/base.mjs"), null);
});

test("RECORD_VERIFICATION_AGGREGATE_EXEMPTIONS is a frozen posix map with inline reasons", () => {
  assert.ok(Object.isFrozen(RECORD_VERIFICATION_AGGREGATE_EXEMPTIONS));
  const keys = Object.keys(RECORD_VERIFICATION_AGGREGATE_EXEMPTIONS).sort();
  assert.deepEqual(keys, [
    "packages/modules/catalog/src/actions/list-products.ts",
    "packages/modules/customers/src/services/count-active-members.ts",
    "packages/modules/customers/src/services/count-linked-counterparties.ts",
    "packages/modules/orders/src/services/order-list/page.ts",
    "packages/modules/pricing/src/services/count-price-list-entries.ts",
  ]);
  for (const key of keys) {
    assert.equal(key, toPosix(key));
    assert.equal(key.includes("\\"), false);
    assert.ok(
      RECORD_VERIFICATION_AGGREGATE_EXEMPTIONS[key].length > 0,
      `${key} must carry an inline reason`,
    );
  }
});

test("showzy/record-verification-aggregates", () => {
  tester.run(
    "showzy/record-verification-aggregates",
    recordVerificationAggregatesRule,
    {
      valid: [
        {
          filename: file(
            "packages/modules/orders/src/services/order-list/aggregate.ts",
          ),
          code: CONSULTING_AGGREGATE,
        },
        {
          filename: file(
            "packages/modules/customers/src/services/count-active-members.ts",
          ),
          code: UNDECLARED_AGGREGATE,
        },
        {
          filename: file(
            "packages/modules/customers/src/services/count-linked-counterparties.ts",
          ),
          code: UNDECLARED_AGGREGATE,
        },
        {
          filename: file(
            "packages/modules/pricing/src/services/count-price-list-entries.ts",
          ),
          code: UNDECLARED_AGGREGATE,
        },
        {
          filename: file(
            "packages/modules/catalog/src/actions/list-products.ts",
          ),
          code: UNDECLARED_AGGREGATE,
        },
        {
          filename: file(
            "packages/modules/orders/src/services/order-list/page.ts",
          ),
          code: UNDECLARED_AGGREGATE,
        },
        {
          filename: `C:\\repo\\packages\\modules\\customers\\src\\services\\count-active-members.ts`,
          code: UNDECLARED_AGGREGATE,
        },
        {
          filename: file(
            "packages/modules/files/src/services/count-objects.ts",
          ),
          code: `
            import { files } from "@showzy/db/schema/files";
            import { count } from "drizzle-orm";
            export const n = count();
          `,
        },
        {
          filename: file("packages/modules/orders/src/services/load-order.ts"),
          code: `
            import { orders } from "@showzy/db/schema/orders";
            import { eq } from "drizzle-orm";
            export const id = orders.id;
            export const same = eq;
          `,
        },
        {
          filename: file(
            "packages/core/src/runtime/pipeline/execute-action.ts",
          ),
          code: UNDECLARED_AGGREGATE,
        },
        {
          filename: file("packages/modules/orders/src/actions/list.db.test.ts"),
          code: UNDECLARED_AGGREGATE,
        },
        {
          filename: file(
            "packages/modules/pricing/src/services/count-price-list-entries.ts",
          ),
          code: `
            import { priceListEntries } from "@showzy/db/schema/pricing";
            import { count } from "drizzle-orm";
            export const n = count();
          `,
        },
      ],
      invalid: [
        {
          filename: file(
            "packages/modules/orders/src/services/count-ai-revenue.ts",
          ),
          code: UNDECLARED_AGGREGATE,
          errors: [{ messageId: "undeclaredProvenanceAggregate" }],
        },
        {
          filename: `C:\\repo\\packages\\modules\\orders\\src\\services\\count-ai-revenue.ts`,
          code: UNDECLARED_AGGREGATE,
          errors: [{ messageId: "undeclaredProvenanceAggregate" }],
        },
        {
          filename: file(
            "packages/modules/documents/src/services/sum-document-gross.ts",
          ),
          code: `
            import { documents } from "@showzy/db/schema/documents";
            import { sum } from "drizzle-orm";
            export const gross = sum(documents.totalGrossMinor);
          `,
          errors: [{ messageId: "undeclaredProvenanceAggregate" }],
        },
      ],
    },
  );
  assert.ok(true);
});

test("fails on a newly added aggregate that neither consults nor is listed (temporary file)", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "sho-489-"));
  const relative =
    "packages/modules/orders/src/services/sho-489-temp-revenue.ts";
  const nested = path.join(directory, ...relative.split("/"));
  mkdirSync(path.dirname(nested), { recursive: true });
  writeFileSync(nested, UNDECLARED_AGGREGATE);
  try {
    tester.run(
      "showzy/record-verification-aggregates",
      recordVerificationAggregatesRule,
      {
        valid: [],
        invalid: [
          {
            filename: nested,
            code: readFileSync(nested, "utf8"),
            errors: [{ messageId: "undeclaredProvenanceAggregate" }],
          },
        ],
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("passes for live order-list/aggregate.ts (consults) and each listed exemption", () => {
  const consulting = file(
    "packages/modules/orders/src/services/order-list/aggregate.ts",
  );
  tester.run(
    "showzy/record-verification-aggregates",
    recordVerificationAggregatesRule,
    {
      valid: [
        {
          filename: consulting,
          code: readFileSync(consulting, "utf8"),
        },
        ...Object.keys(RECORD_VERIFICATION_AGGREGATE_EXEMPTIONS).map(
          (relative) => ({
            filename: file(relative),
            code: readFileSync(file(relative), "utf8"),
          }),
        ),
      ],
      invalid: [],
    },
  );
});
