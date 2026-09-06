/**
 * Boundary proof (SHO-309 + SHO-329): the app's own ESLint config must
 * reject `@showzy/contract/server`, module packages, and platform server
 * packages from `apps/web` while allowing the client allowlist (contract.md
 * §2, ADR-0030), and must enforce feature/page/layout import direction.
 * Probe snippets are written as real files under `src/` and linted with
 * the FULL config array exported by this package's real
 * `eslint.config.mjs`, so a future `ignores` entry (or any other config
 * change) that stopped the boundary from firing would fail these tests.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import webEslintConfig from "../eslint.config.mjs";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const srcRoot = path.join(appRoot, "src");

/**
 * Probe files created under `src/` for the duration of this suite. Real
 * files (not virtual filenames) so the config's type-aware parsing and any
 * `ignores` entries apply exactly as they do when CI runs `eslint .`.
 * Keys are paths relative to `src/`. Basenames are unique so assertions
 * can look up by filename.
 */
const probeFiles = {
  "__boundary-probe__/contract-server.ts": `import { buildServerRouter } from "@showzy/contract/server";\n`,
  "__boundary-probe__/module-orders.ts": `import { ordersConfirm } from "@showzy/orders";\n`,
  "__boundary-probe__/module-customers-contract.ts": `import { customersContract } from "@showzy/customers/contract";\n`,
  "__boundary-probe__/platform-core.ts": `import { anything } from "@showzy/core";\n`,
  "__boundary-probe__/platform-db.ts": `import { anything } from "@showzy/db";\n`,
  "__boundary-probe__/platform-config.ts": `import { anything } from "@showzy/config";\n`,
  "__boundary-probe__/platform-ai.ts": `import { anything } from "@showzy/ai";\n`,
  "__boundary-probe__/client-allowlist.ts": `
    import { createContractClient } from "@showzy/contract";
    import { moneySchema } from "@showzy/validation";
    import { Button } from "@showzy/ui";
    import { sharedOrdersCopy } from "@showzy/copy/orders";
    import { createWebAdapter } from "@showzy/document-signing/web";
    import { useQuery } from "@tanstack/react-query";
    import { createFileRoute } from "@tanstack/react-router";
    import { useState } from "react";
  `,
  "routes/__boundary-probe__/route-allowed-page.ts": `import { SignInScreen } from "../../features/auth/sign-in-screen";\n`,
  "routes/__boundary-probe__/route-allowed-prefetch.ts": `import { contractQueryOptions } from "../../api/query-options";\n`,
  "routes/__boundary-probe__/route-allowed-layout.ts": `import { PanelChromeLayout } from "../../layouts/panel/panel-layout";\n`,
  "routes/__boundary-probe__/route-forbidden-client.ts": `import { createShowzyClient } from "../../api/client";\n`,
  "routes/__boundary-probe__/route-forbidden-contract.ts": `import { createContractClient } from "@showzy/contract";\n`,
  "routes/__boundary-probe__/route-forbidden-contract-subpath.ts": `import { buildServerRouter } from "@showzy/contract/server";\n`,
  "routes/__boundary-probe__/route-forbidden-internal.ts": `import { planCreateCompanySubmit } from "../../features/companies/onboarding/create-company-form";\n`,
  "components/ui/__boundary-probe__/ui-allowed-cx.ts": `import { cx } from "../cx";\n`,
  "components/ui/__boundary-probe__/ui-forbidden-feature.ts": `import { useListMine } from "../../../features/companies/api/use-list-mine";\n`,
  "components/ui/__boundary-probe__/ui-forbidden-api.ts": `import { createShowzyClient } from "../../../api/client";\n`,
  "api/__boundary-probe__/api-allowed-auth.ts": `import { useAuthSession } from "../../auth/session-provider";\n`,
  "api/__boundary-probe__/api-forbidden-ui.ts": `import { Button } from "../../components/ui/button";\n`,
  "features/companies/__boundary-probe__/companies-allowed-auth-shared.ts": `import { Banner } from "../../auth/shared/banner";\n`,
  "features/companies/__boundary-probe__/companies-forbidden-auth-internal.ts": `import { OtpInput } from "../../auth/otp-input";\n`,
  "features/companies/__boundary-probe__/companies-forbidden-layout.ts": `import { PanelChrome } from "../../../layouts/panel/panel-chrome";\n`,
  "features/companies/__boundary-probe__/companies-forbidden-app.ts": `import { createAppRuntime } from "../../../app/runtime";\n`,
  "features/companies/__boundary-probe__/view-forbidden-client.ts": `import { createShowzyClient } from "../../../api/client";\n`,
  "features/companies/api/__boundary-probe__/api-allowed-client.ts": `import type { ShowzyClient } from "../../../../api/client";\n`,
  "features/auth/__boundary-probe__/auth-forbidden-companies.ts": `import { planCreateCompanySubmit } from "../../companies/onboarding/create-company-form";\n`,
  "layouts/panel/__boundary-probe__/layout-allowed-companies.ts": `import { CompanySwitcher } from "../../../features/companies/scope/company-switcher";\n`,
  "layouts/panel/__boundary-probe__/layout-allowed-companies-api.ts": `import type { CompanyMembership } from "../../../features/companies/api/list-mine";\n`,
  "layouts/panel/__boundary-probe__/layout-forbidden-auth-screen.ts": `import { SignInScreen } from "../../../features/auth/sign-in-screen";\n`,
  "layouts/panel/__boundary-probe__/layout-forbidden-onboarding.ts": `import { planCreateCompanySubmit } from "../../../features/companies/onboarding/create-company-form";\n`,
};

const probeDirectories = [
  path.join(srcRoot, "__boundary-probe__"),
  path.join(srcRoot, "routes", "__boundary-probe__"),
  path.join(srcRoot, "components", "ui", "__boundary-probe__"),
  path.join(srcRoot, "api", "__boundary-probe__"),
  path.join(srcRoot, "features", "companies", "__boundary-probe__"),
  path.join(srcRoot, "features", "companies", "api", "__boundary-probe__"),
  path.join(srcRoot, "features", "auth", "__boundary-probe__"),
  path.join(srcRoot, "layouts", "panel", "__boundary-probe__"),
];

/** @type {Map<string, import("eslint").Linter.LintMessage[]>} */
let messagesByProbe = new Map();

beforeAll(async () => {
  await Promise.all(
    probeDirectories.map((directory) => mkdir(directory, { recursive: true })),
  );
  await Promise.all(
    Object.entries(probeFiles).map(([rel, code]) =>
      writeFile(path.join(srcRoot, rel), code),
    ),
  );
  const eslint = new ESLint({
    cwd: appRoot,
    // The whole exported config array — no synthetic wrapper config, so
    // `ignores` entries and every other real config entry stay in force.
    overrideConfigFile: true,
    overrideConfig: webEslintConfig,
  });
  const results = await eslint.lintFiles(
    Object.keys(probeFiles).map((rel) => path.join(srcRoot, rel)),
  );
  messagesByProbe = new Map(
    results.map((result) => [path.basename(result.filePath), result.messages]),
  );
}, 120_000);

afterAll(async () => {
  await Promise.all(
    probeDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

/**
 * @param {string} probeName
 * @param {string} ruleId
 */
function ruleErrors(probeName, ruleId) {
  const messages = messagesByProbe.get(probeName);
  if (messages === undefined) {
    throw new Error(`probe ${probeName} was not linted`);
  }
  return messages.filter((message) => message.ruleId === ruleId);
}

/**
 * @param {string} probeName
 */
function boundaryErrors(probeName) {
  return ruleErrors(probeName, "showzy/import-boundaries");
}

/**
 * @param {string} probeName
 */
function layerErrors(probeName) {
  return ruleErrors(probeName, "showzy-web/layer-boundaries");
}

describe("apps/web clientApp import boundary (SHO-309)", () => {
  it("keeps showzy/import-boundaries as an error in the app config", () => {
    const wired = webEslintConfig.some(
      (entry) => entry.rules?.["showzy/import-boundaries"] === "error",
    );
    expect(wired).toBe(true);
  });

  it("rejects @showzy/contract/server from app code", () => {
    const messages = boundaryErrors("contract-server.ts");
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toContain("Client apps may import only");
  });

  it("rejects module packages from app code", () => {
    expect(boundaryErrors("module-orders.ts")).toHaveLength(1);
    expect(boundaryErrors("module-customers-contract.ts")).toHaveLength(1);
  });

  it("rejects platform server packages from app code", () => {
    for (const probeName of [
      "platform-core.ts",
      "platform-db.ts",
      "platform-config.ts",
      "platform-ai.ts",
    ]) {
      expect(boundaryErrors(probeName)).toHaveLength(1);
    }
  });

  it("allows the client allowlist and plain npm packages", () => {
    expect(boundaryErrors("client-allowlist.ts")).toHaveLength(0);
  });
});

describe("apps/web layer import direction (SHO-329)", () => {
  it("keeps showzy-web/layer-boundaries as an error in the app config", () => {
    const wired = webEslintConfig.some(
      (entry) => entry.rules?.["showzy-web/layer-boundaries"] === "error",
    );
    expect(wired).toBe(true);
  });

  it("allows a route to import a feature page, query-options prefetch, and layouts", () => {
    expect(layerErrors("route-allowed-page.ts")).toHaveLength(0);
    expect(layerErrors("route-allowed-prefetch.ts")).toHaveLength(0);
    expect(layerErrors("route-allowed-layout.ts")).toHaveLength(0);
  });

  it("rejects a route importing the contract client or feature internals", () => {
    expect(layerErrors("route-forbidden-client.ts")).toHaveLength(1);
    expect(layerErrors("route-forbidden-contract.ts")).toHaveLength(1);
    expect(layerErrors("route-forbidden-contract-subpath.ts")).toHaveLength(1);
    expect(layerErrors("route-forbidden-internal.ts")).toHaveLength(1);
  });

  it("allows generic UI to import another UI primitive and rejects features and API", () => {
    expect(layerErrors("ui-allowed-cx.ts")).toHaveLength(0);
    expect(layerErrors("ui-forbidden-feature.ts")).toHaveLength(1);
    expect(layerErrors("ui-forbidden-api.ts")).toHaveLength(1);
  });

  it("allows shared API to import auth and rejects UI", () => {
    expect(layerErrors("api-allowed-auth.ts")).toHaveLength(0);
    expect(layerErrors("api-forbidden-ui.ts")).toHaveLength(1);
  });

  it("allows a feature to import another domain's shared entry and rejects internals", () => {
    expect(layerErrors("companies-allowed-auth-shared.ts")).toHaveLength(0);
    expect(layerErrors("companies-forbidden-auth-internal.ts")).toHaveLength(1);
    expect(layerErrors("auth-forbidden-companies.ts")).toHaveLength(1);
  });

  it("rejects a feature importing layouts or app", () => {
    expect(layerErrors("companies-forbidden-layout.ts")).toHaveLength(1);
    expect(layerErrors("companies-forbidden-app.ts")).toHaveLength(1);
  });

  it("rejects a view importing the contract client and allows feature api adapters", () => {
    expect(layerErrors("view-forbidden-client.ts")).toHaveLength(1);
    expect(layerErrors("api-allowed-client.ts")).toHaveLength(0);
  });

  it("allows the panel layout to compose companies scope/api and rejects other domains", () => {
    expect(layerErrors("layout-allowed-companies.ts")).toHaveLength(0);
    expect(layerErrors("layout-allowed-companies-api.ts")).toHaveLength(0);
    expect(layerErrors("layout-forbidden-auth-screen.ts")).toHaveLength(1);
    expect(layerErrors("layout-forbidden-onboarding.ts")).toHaveLength(1);
  });
});
