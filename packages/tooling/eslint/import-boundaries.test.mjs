import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";

import { importBoundariesRule } from "./import-boundaries.mjs";
import {
  showzyBoundaryDependencyOptions,
  showzyBoundarySettings,
} from "./base.mjs";

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

test("showzy/import-boundaries", () => {
  tester.run("showzy/import-boundaries", importBoundariesRule, {
    valid: [
      {
        filename: file("packages/modules/orders/actions/create.contract.ts"),
        code: `
          import { z } from "zod";
          import { defineActionContract } from "@showzy/core/contract";
          import { moneySchema } from "@showzy/validation";
        `,
      },
      {
        filename: file(
          "packages/modules/catalog/src/actions/create-product.contract.ts",
        ),
        code: `
          import { z } from "zod";
          import { defineActionContract } from "@showzy/core/contract";
          import { catalogNameSchema } from "@showzy/validation/catalog";
        `,
      },
      {
        filename: file("packages/modules/orders/actions/create.ts"),
        code: `import { orders } from "@showzy/db/schema/orders";`,
      },
      {
        filename: file("packages/modules/orders/actions/create.ts"),
        code: `import { catalogGetFacts } from "@showzy/catalog";`,
      },
      {
        filename: file("packages/modules/orders/src/services/create-order.ts"),
        code: `import { postgresUniqueConstraint } from "@showzy/module-kit/postgres-unique";`,
      },
      {
        filename: file(
          "packages/modules/doc-generation/src/services/put-generated-pdf.ts",
        ),
        code: `import { documentObjectKey, getFilesObjectStore } from "@showzy/files/storage";`,
      },
      {
        filename: file("packages/modules/documents/src/actions/get.ts"),
        code: `import { getArtifact } from "@showzy/doc-generation/get-artifact";`,
      },
      {
        filename: file(
          "packages/modules/documents/src/actions/create-from-order.ts",
        ),
        code: `import { resolveLayout } from "@showzy/doc-generation/resolve-layout";`,
      },
      {
        filename: file("packages/modules/doc-signing/src/actions/start.ts"),
        code: `import { getArtifact } from "@showzy/doc-generation/get-artifact";`,
      },
      {
        filename: file("packages/modules/documents/src/actions/get.ts"),
        code: `import { getSigning } from "@showzy/doc-signing/get";`,
      },
      {
        filename: file("packages/modules/documents/src/actions/list.ts"),
        code: `import { getSupplierSignedFlags } from "@showzy/doc-signing/get-supplier-signed-flags";`,
      },
      {
        filename: file(
          "packages/modules/pricing/src/actions/resolve-product-prices.ts",
        ),
        code: `import { getCustomerPricingFacts } from "@showzy/customers/get-customer-pricing-facts";`,
      },
      {
        filename: file(
          "packages/modules/customers/src/services/resolve-price-list.ts",
        ),
        code: `import { getPriceList } from "@showzy/pricing/get-price-list";`,
      },
      {
        filename: file("packages/modules/search/services/index.ts"),
        code: `import { products } from "@showzy/db/schema/catalog";`,
      },
      {
        filename: file("packages/contract/src/client/wire-errors.ts"),
        code: `import type { CoreErrorCode } from "@showzy/core/errors";`,
      },
      {
        filename: file("packages/contract/src/client/index.ts"),
        code: `
          import { createORPCClient } from "@orpc/client";
          import { defineActionContract } from "@showzy/core/contract";
          import { listThings } from "@showzy/orders/contract";
          import { moneyWireSchema } from "@showzy/validation/money";
        `,
      },
      {
        filename: file("packages/contract/src/client/modules.ts"),
        code: `export { listThings } from "@showzy/orders/contract";`,
      },
      {
        filename: file("apps/mobile/src/app/index.ts"),
        code: `
          import { createContractClient } from "@showzy/contract";
          import { moneySchema } from "@showzy/validation";
          import { catalogNameSchema } from "@showzy/validation/catalog";
          import { Button } from "@showzy/ui";
          import { sharedOrdersCopy } from "@showzy/copy/orders";
          import { formChromeEn } from "@showzy/copy/chrome";
          import { sharedAuthCopy } from "@showzy/copy/auth";
          import { sharedPanelCopy } from "@showzy/copy/panel";
          import { sharedCompaniesOnboardingCopy } from "@showzy/copy/companies";
          import { DocumentSigner } from "@showzy/document-signing";
          import { createNativeAdapter } from "@showzy/document-signing/native";
          import { useState } from "react";
        `,
      },
      {
        filename: file("apps/mobile/eslint.config.mjs"),
        code: `import { showzyEslintConfig } from "@showzy/tooling/eslint";`,
      },
      {
        filename: file("packages/modules/orders/actions/create.test.ts"),
        code: `import { users } from "@showzy/db";`,
      },
      {
        filename: file("packages/ai/src/tool-facades/orders-list.ts"),
        code: `
          import type { ActionContract } from "@showzy/core/contract";
          import { staffHasPermission } from "@showzy/core";
          import { aiToolSourcesForPrincipal } from "@showzy/contract";
          import { LIST_ORDERS_QUERY_MAX } from "@showzy/orders/contract";
          import { CUSTOMER_NAME_MAX } from "@showzy/validation/customers";
        `,
      },
      {
        filename: file("packages/copy/src/orders.ts"),
        code: `
          import { selectCopy, type Locale } from "./locale.js";
          import type { CountForms } from "./plural.js";
        `,
      },
    ],
    invalid: [
      {
        filename: file("packages/modules/orders/actions/create.contract.ts"),
        code: `import { users } from "@showzy/db";`,
        errors: [{ messageId: "actionContract" }],
      },
      {
        filename: file("packages/modules/orders/actions/create.contract.ts"),
        code: `import { implementAction } from "@showzy/core";`,
        errors: [{ messageId: "actionContract" }],
      },
      {
        filename: file("packages/modules/orders/actions/create.contract.ts"),
        code: `import { uniqueIds } from "@showzy/module-kit/unique-ids";`,
        errors: [{ messageId: "actionContract" }],
      },
      {
        filename: file("apps/mobile/src/app/index.ts"),
        code: `import { sha256Hex } from "@showzy/module-kit/sha256";`,
        errors: [{ messageId: "clientApp" }],
      },
      {
        filename: file("apps/web/src/app/page.ts"),
        code: `import { requireWritable } from "@showzy/module-kit/writable";`,
        errors: [{ messageId: "clientApp" }],
      },
      {
        filename: file("packages/modules/orders/actions/create.ts"),
        code: `import { products } from "@showzy/db/schema/catalog";`,
        errors: [{ messageId: "moduleSchema" }],
      },
      {
        filename: file("packages/modules/documents/src/actions/list.ts"),
        code: `import { signingSignatures } from "@showzy/db/schema/doc-signing";`,
        errors: [{ messageId: "moduleSchema" }],
      },
      {
        filename: file("packages/modules/orders/actions/create.ts"),
        code: `import { users } from "@showzy/db";`,
        errors: [{ messageId: "moduleSchema" }],
      },
      {
        filename: file("packages/modules/orders/actions/create.ts"),
        code: `import { helper } from "@showzy/catalog/services/helper";`,
        errors: [{ messageId: "moduleCross" }],
      },
      {
        filename: file("packages/modules/orders/actions/create.ts"),
        code: `import { getPriceList } from "@showzy/pricing/get-price-list";`,
        errors: [{ messageId: "moduleCross" }],
      },
      {
        filename: file("packages/modules/orders/actions/create.ts"),
        code: `import { getFilesObjectStore } from "@showzy/files/storage";`,
        errors: [{ messageId: "moduleCross" }],
      },
      {
        filename: file("packages/modules/orders/actions/create.ts"),
        code: `import { contractRouter } from "@showzy/contract";`,
        errors: [{ messageId: "moduleCross" }],
      },
      {
        filename: file("packages/contract/src/client/index.ts"),
        code: `import { executeAction } from "@showzy/core";`,
        errors: [{ messageId: "contractClient" }],
      },
      {
        filename: file("packages/contract/src/client/index.ts"),
        code: `import { readFile } from "node:fs";`,
        errors: [{ messageId: "contractClient" }],
      },
      {
        filename: file("packages/contract/src/client/modules.ts"),
        code: `import { createOrder } from "@showzy/orders";`,
        errors: [{ messageId: "contractClient" }],
      },
      {
        filename: file("packages/contract/src/server/index.ts"),
        code: `import { createOrder } from "@showzy/orders";`,
        errors: [{ messageId: "contractModules" }],
      },
      {
        filename: file("packages/copy/src/orders.ts"),
        code: `import { useState } from "react";`,
        errors: [{ messageId: "copyLeaf" }],
      },
      {
        filename: file("packages/copy/src/orders.ts"),
        code: `import { View } from "react-native";`,
        errors: [{ messageId: "copyLeaf" }],
      },
      {
        filename: file("packages/copy/src/orders.ts"),
        code: `import { StyleSheet } from "react-native-unistyles";`,
        errors: [{ messageId: "copyLeaf" }],
      },
      {
        filename: file("packages/copy/src/orders.ts"),
        code: `import tailwind from "tailwindcss";`,
        errors: [{ messageId: "copyLeaf" }],
      },
      {
        filename: file("packages/copy/src/orders.ts"),
        code: `import { getLocales } from "expo-localization";`,
        errors: [{ messageId: "copyLeaf" }],
      },
      {
        filename: file("packages/copy/src/orders.ts"),
        code: `import { ordersCopy } from "../../../apps/web/src/i18n/orders";`,
        errors: [{ messageId: "copyLeaf" }],
      },
      {
        filename: file("packages/modules/orders/actions/create.ts"),
        code: `import { sharedOrdersCopy } from "@showzy/copy/orders";`,
        errors: [{ messageId: "copyClientOnly" }],
      },
      {
        filename: file("apps/mobile/src/app/index.ts"),
        code: `import { executeAction } from "@showzy/core";`,
        errors: [{ messageId: "clientApp" }],
      },
      {
        filename: file("apps/web/src/app/page.ts"),
        code: `import { users } from "@showzy/db";`,
        errors: [{ messageId: "clientApp" }],
      },
      {
        filename: file("apps/mobile/src/app/index.ts"),
        code: `import { verifyAsic } from "@showzy/document-signing/node";`,
        errors: [{ messageId: "clientApp" }],
      },
      {
        filename: file("apps/mobile/src/app/index.ts"),
        code: `import { staffAssistantSystemPrompt } from "@showzy/ai";`,
        errors: [{ messageId: "clientApp" }],
      },
      {
        filename: file("apps/web/src/app/page.ts"),
        code: `import { filterStaffAiTools } from "@showzy/ai";`,
        errors: [{ messageId: "clientApp" }],
      },
      {
        filename: file("packages/modules/orders/actions/create.ts"),
        code: `import { actionContractToTool } from "@showzy/ai";`,
        errors: [{ messageId: "moduleAi" }],
      },
      {
        filename: file(
          "packages/modules/customers/src/actions/delete-customer.ts",
        ),
        code: `import { filterStaffAiTools } from "@showzy/ai";`,
        errors: [{ messageId: "moduleAi" }],
      },
      {
        filename: file("packages/ai/src/tool-facades/orders-list.ts"),
        code: `import { createOrder } from "@showzy/orders";`,
        errors: [{ messageId: "aiModuleBarrel" }],
      },
      {
        filename: file("packages/ai/src/tool-facades/orders-list.ts"),
        code: `import { users } from "@showzy/db";`,
        errors: [{ messageId: "aiModuleBarrel" }],
      },
    ],
  });
  assert.ok(true);
});

test("boundaries map includes the ai element and forbids client/module imports", () => {
  const settings = showzyBoundarySettings(repoRoot);
  const elements = settings["boundaries/elements"];
  assert.ok(
    elements.some(
      (element) => element.type === "ai" && element.pattern === "packages/ai",
    ),
    "boundaries/elements must declare type ai for packages/ai",
  );

  const policies = showzyBoundaryDependencyOptions.policies;
  assert.ok(
    policies.some(
      (policy) =>
        policy.from?.file?.categories === "client-app" &&
        policy.disallow?.to?.module?.source === "@showzy/ai",
    ),
    "client apps must be disallowed from importing @showzy/ai",
  );
  assert.ok(
    policies.some(
      (policy) =>
        policy.from?.element?.type === "module" &&
        policy.disallow?.to?.element?.type === "ai",
    ),
    "domain modules must be disallowed from depending on the ai element",
  );
  assert.ok(
    policies.some(
      (policy) =>
        policy.from?.element?.type === "module" &&
        policy.disallow?.to?.module?.source === "@showzy/ai",
    ),
    "domain modules must be disallowed from importing @showzy/ai",
  );
});

test("@showzy/validation runtime dependency is only zod (SHO-423)", () => {
  const pkg = JSON.parse(
    readFileSync(
      path.join(repoRoot, "packages/validation/package.json"),
      "utf8",
    ),
  );
  assert.deepEqual(Object.keys(pkg.dependencies), ["zod"]);
});

test("@showzy/copy has no runtime dependencies (SHO-414)", () => {
  const pkg = JSON.parse(
    readFileSync(path.join(repoRoot, "packages/copy/package.json"), "utf8"),
  );
  assert.equal(pkg.dependencies, undefined);
});
