/**
 * Spec-driven import boundaries (contract.md §2, ADR-0014, ADR-0016).
 *
 * eslint-plugin-boundaries owns the package-level element map; this rule
 * matches on the *specifier string* and the importer's path so it does not
 * depend on resolving workspace packages through pnpm's node_modules layout.
 * Module tasks copy these messages — do not weaken them without an ADR.
 */
import { builtinModules } from "node:module";

const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) =>
    name.startsWith("node:") ? name.slice("node:".length) : `node:${name}`,
  ),
]);

/** Platform packages — never treated as a domain module barrel. */
const PLATFORM_PACKAGES = new Set([
  "ai",
  "assistant-kit",
  "config",
  "contract",
  "copy",
  "core",
  "db",
  "document-signing",
  "money",
  "module-kit",
  "tooling",
  "ui",
  "validation",
]);

/** Projection modules may import foreign schemas; contract-check enforces grants. */
const PROJECTION_MODULES = new Set(["search", "analytics"]);

/**
 * Domain barrels the eval sandbox may import so tool `execute` is
 * `executeAction` (SHO-412). Not a general module allowlist.
 */
const AI_EVAL_MODULE_PACKAGES = new Set([
  "catalog",
  "companies",
  "customers",
  "orders",
  "pricing",
]);

const CLIENT_APPS = new Set(["mobile", "web"]);

/**
 * @param {string} filename
 */
function toPosix(filename) {
  return filename.replaceAll("\\", "/");
}

/**
 * @param {string} spec
 */
function isRelative(spec) {
  return spec.startsWith("./") || spec.startsWith("../");
}

/**
 * @param {string} spec
 * @returns {{ name: string, rest: string } | null}
 */
function showzyPackage(spec) {
  const match = /^@showzy\/([^/]+)(?:\/(.*))?$/.exec(spec);
  if (match === null || match[1] === undefined) {
    return null;
  }
  return { name: match[1], rest: match[2] ?? "" };
}

/**
 * @param {string} filename
 */
function classify(filename) {
  const path = toPosix(filename);
  if (
    /\.db\.test\.ts$/.test(path) ||
    /\.test\.ts$/.test(path) ||
    /\/probe\/leaks\//.test(path) ||
    /\/scripts\//.test(path) ||
    /\/migrations\//.test(path) ||
    /\/eslint\.config\.mjs$/.test(path) ||
    /\/vitest\.config\.mjs$/.test(path) ||
    /\.cjs$/.test(path)
  ) {
    return { kind: "skip" };
  }
  if (path.endsWith(".contract.ts")) {
    return { kind: "action-contract" };
  }
  if (path.includes("/packages/contract/src/client/")) {
    return { kind: "contract-client" };
  }
  if (path.includes("/packages/contract/")) {
    return { kind: "contract" };
  }
  const appMatch = /\/apps\/([^/]+)\//.exec(path);
  if (appMatch !== null && CLIENT_APPS.has(appMatch[1] ?? "")) {
    return { kind: "client-app" };
  }
  const moduleMatch = /\/packages\/modules\/([^/]+)\//.exec(path);
  if (moduleMatch !== null && moduleMatch[1] !== undefined) {
    return { kind: "module", module: moduleMatch[1] };
  }
  if (path.includes("/packages/ai-eval/")) {
    return { kind: "ai-eval" };
  }
  if (path.includes("/packages/ai/")) {
    return { kind: "ai" };
  }
  if (path.includes("/packages/copy/")) {
    return { kind: "copy" };
  }
  return { kind: "skip" };
}

/**
 * @param {import("estree").Node} node
 */
function isTypeOnly(node) {
  if ("importKind" in node && node.importKind === "type") {
    return true;
  }
  if ("exportKind" in node && node.exportKind === "type") {
    return true;
  }
  if ("specifiers" in node && Array.isArray(node.specifiers)) {
    const specifiers = node.specifiers;
    return (
      specifiers.length > 0 &&
      specifiers.every(
        (specifier) =>
          ("importKind" in specifier && specifier.importKind === "type") ||
          ("exportKind" in specifier && specifier.exportKind === "type"),
      )
    );
  }
  return false;
}

/**
 * @param {{ kind: string, module?: string }} from
 * @param {string} spec
 * @param {boolean} typeOnly
 * @returns {{ messageId: string, data?: Record<string, string> } | null}
 */
function violation(from, spec, typeOnly) {
  if (from.kind === "action-contract") {
    if (isRelative(spec) || spec === "zod") {
      return null;
    }
    if (spec === "@showzy/core/contract") {
      return null;
    }
    if (
      spec === "@showzy/validation" ||
      spec.startsWith("@showzy/validation/")
    ) {
      return null;
    }
    return { messageId: "actionContract" };
  }

  const pkg = showzyPackage(spec);

  if (from.kind === "contract-client") {
    if (isRelative(spec)) {
      return null;
    }
    if (spec.startsWith("node:") || NODE_BUILTINS.has(spec)) {
      return { messageId: "contractClient" };
    }
    // Non-@showzy npm packages are currently allowed (zod, @orpc/*).
    // Tighten to an explicit external allowlist when the dependency set
    // grows (fnd-G1 A12 / tooling AGENTS).
    if (pkg === null) {
      return null;
    }
    if (pkg.name === "core" && pkg.rest === "contract") {
      return null;
    }
    if (pkg.name === "core" && pkg.rest === "errors" && typeOnly) {
      return null;
    }
    if (pkg.name === "validation") {
      return null;
    }
    if (pkg.name === "contract" && (pkg.rest === "" || pkg.rest === "server")) {
      return pkg.rest === "server" ? { messageId: "contractClient" } : null;
    }
    if (!PLATFORM_PACKAGES.has(pkg.name) && pkg.rest === "contract") {
      return null;
    }
    return { messageId: "contractClient" };
  }

  if (from.kind === "contract") {
    if (
      pkg !== null &&
      !PLATFORM_PACKAGES.has(pkg.name) &&
      pkg.rest !== "contract"
    ) {
      return { messageId: "contractModules" };
    }
    return null;
  }

  if (from.kind === "copy") {
    if (isRelative(spec) && !spec.includes("/apps/")) {
      return null;
    }
    return { messageId: "copyLeaf" };
  }

  if (from.kind === "client-app") {
    if (pkg === null) {
      return null;
    }
    if (pkg.name === "contract" && pkg.rest === "") {
      return null;
    }
    if (pkg.name === "validation" || pkg.name === "ui" || pkg.name === "copy") {
      return null;
    }
    // SHO-251 / SHO-260: on-device QES via Nitro. Native and web adapters
    // only — never the Node verify path (node:zlib / WASM).
    if (
      pkg.name === "document-signing" &&
      (pkg.rest === "" || pkg.rest === "native" || pkg.rest === "web")
    ) {
      return null;
    }
    return { messageId: "clientApp" };
  }

  if (from.kind === "module") {
    if (pkg === null) {
      return null;
    }
    const moduleName = from.module ?? "";
    if (pkg.name === "db") {
      if (pkg.rest === `schema/${moduleName}`) {
        return null;
      }
      if (
        PROJECTION_MODULES.has(moduleName) &&
        pkg.rest.startsWith("schema/")
      ) {
        return null;
      }
      return { messageId: "moduleSchema", data: { module: moduleName } };
    }
    if (pkg.name === "ai") {
      return { messageId: "moduleAi" };
    }
    if (pkg.name === "ai-eval") {
      return { messageId: "moduleAiEval" };
    }
    if (pkg.name === "copy") {
      return { messageId: "copyClientOnly" };
    }
    if (pkg.name === "contract") {
      return { messageId: "moduleCross" };
    }
    if (PLATFORM_PACKAGES.has(pkg.name)) {
      return null;
    }
    if (pkg.rest !== "") {
      // SHO-236: the process-wide object store is bound at api/worker boot.
      // doc-generation PUTs generated PDFs through that singleton; the
      // files package index may export only actions/events (ADR-0015).
      if (
        moduleName === "doc-generation" &&
        pkg.name === "files" &&
        pkg.rest === "storage"
      ) {
        return null;
      }
      // SHO-236 / SHO-365: documents nest getArtifact and resolveLayout
      // without importing the doc-generation barrel (that barrel also
      // exports renderPdf, which imports documents.getForGeneration —
      // ESM + tsc cycle through TSX).
      if (
        moduleName === "documents" &&
        pkg.name === "doc-generation" &&
        (pkg.rest === "get-artifact" || pkg.rest === "resolve-layout")
      ) {
        return null;
      }
      // SHO-286: docSigning.start nests getArtifact for the payload fileId
      // without importing the doc-generation barrel (renderPdf →
      // documents.getForGeneration — ESM cycle).
      if (
        moduleName === "doc-signing" &&
        pkg.name === "doc-generation" &&
        pkg.rest === "get-artifact"
      ) {
        return null;
      }
      // SHO-256: documents.get/list/requestSign/cancel nest signing reads
      // without importing the doc-signing barrel (that barrel also exports
      // abandonRequest, which imports the documents barrel — ESM cycle).
      // Not a schema-join exception (ADR-0014 still forbids
      // @showzy/db/schema/doc-signing from documents).
      if (
        moduleName === "documents" &&
        pkg.name === "doc-signing" &&
        (pkg.rest === "get" || pkg.rest === "get-supplier-signed-flags")
      ) {
        return null;
      }
      // SHO-88 / SHO-281: pricing.resolveProductPrices nests the customers
      // pricing facts and customers.resolveGroupPriceListId nests the pricing
      // point read. Through the barrels those two edges close a real ESM
      // cycle (customers/index -> createGroup -> resolveGroupPriceListId ->
      // pricing/index -> resolveProductPrices -> customers/index); the leaf
      // entries import nothing back, so the cycle is gone at module level.
      // ADR-0015 composition is unchanged: both stay a ctx.call of a read
      // action, only the specifier is narrowed.
      if (
        moduleName === "pricing" &&
        pkg.name === "customers" &&
        pkg.rest === "get-customer-pricing-facts"
      ) {
        return null;
      }
      if (
        moduleName === "customers" &&
        pkg.name === "pricing" &&
        pkg.rest === "get-price-list"
      ) {
        return null;
      }
      return { messageId: "moduleCross" };
    }
    return null;
  }

  if (from.kind === "ai") {
    if (isRelative(spec)) {
      return null;
    }
    if (spec.startsWith("node:") || NODE_BUILTINS.has(spec)) {
      return null;
    }
    if (pkg === null) {
      return null;
    }
    if (pkg.name === "core") {
      return null;
    }
    if (pkg.name === "contract" && pkg.rest === "") {
      return null;
    }
    if (pkg.name === "validation") {
      return null;
    }
    if (!PLATFORM_PACKAGES.has(pkg.name) && pkg.rest === "contract") {
      return null;
    }
    if (pkg.name === "ai-eval") {
      return { messageId: "aiEvalImport" };
    }
    return { messageId: "aiModuleBarrel" };
  }

  if (from.kind === "ai-eval") {
    if (isRelative(spec) && !spec.includes("/apps/")) {
      return null;
    }
    if (spec.startsWith("node:") || NODE_BUILTINS.has(spec)) {
      return null;
    }
    if (pkg === null) {
      return null;
    }
    if (
      pkg.name === "ai" ||
      pkg.name === "core" ||
      pkg.name === "config" ||
      pkg.name === "contract" ||
      pkg.name === "validation" ||
      pkg.name === "db"
    ) {
      return null;
    }
    if (
      AI_EVAL_MODULE_PACKAGES.has(pkg.name) &&
      (pkg.rest === "" || pkg.rest === "contract")
    ) {
      return null;
    }
    return { messageId: "aiEvalLeaf" };
  }

  return null;
}

export const importBoundariesRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Enforce client-safe descriptor imports, schema ownership, and client-app package allowlists.",
    },
    schema: [],
    messages: {
      actionContract:
        "*.contract.ts may import only zod, @showzy/core/contract, and @showzy/validation (contract.md §2).",
      moduleSchema:
        'Module "{{module}}" may import only @showzy/db/schema/{{module}} (ADR-0014). Projection modules (search/analytics) may import foreign schemas; the contract check enforces the matching read-model grant.',
      moduleCross:
        "Modules may import other modules only through their package index.ts; packages/contract is not a module dependency (ADR-0015, ADR-0016).",
      moduleAi:
        "Domain modules may not import @showzy/ai (ADR-0032). The API composition root mounts the AI loop.",
      contractModules:
        "packages/contract may import only a module's index.contract.ts barrel (@showzy/<module>/contract) (ADR-0016).",
      clientApp:
        "Client apps may import only @showzy/contract, @showzy/validation, @showzy/copy, @showzy/ui, and @showzy/document-signing (native/web adapters; never /node) (contract.md §2, SHO-251, SHO-414).",
      copyLeaf:
        "packages/copy is a client-safe leaf: only relative imports (no React, React Native, Unistyles, Tailwind, Expo, apps, or other packages) (SHO-414).",
      copyClientOnly:
        "Domain modules may not import @showzy/copy (client staff copy, SHO-414).",
      contractClient:
        "The contract client layer must not import Node builtins, @showzy/db, core server paths, or @showzy/contract/server (ADR-0016).",
      aiModuleBarrel:
        "packages/ai may import @showzy/core/*, @showzy/contract, @showzy/validation/*, and @showzy/<module>/contract; it must not import a module barrel or @showzy/db (ADR-0016, ADR-0032).",
      aiEvalImport: "packages/ai must not import @showzy/ai-eval (SHO-412).",
      aiEvalLeaf:
        "packages/ai-eval may import @showzy/ai, @showzy/core, @showzy/config, @showzy/contract, @showzy/validation, @showzy/db, and the catalog/companies/customers/orders/pricing barrels or */contract; it must not import apps, copy, or ui (SHO-412).",
      moduleAiEval: "Domain modules may not import @showzy/ai-eval (SHO-412).",
    },
  },
  create(context) {
    const from = classify(context.filename);
    if (from.kind === "skip") {
      return {};
    }

    /**
     * @param {import("estree").Node} node
     * @param {string} spec
     */
    function reportIfNeeded(node, spec) {
      const result = violation(from, spec, isTypeOnly(node));
      if (result !== null) {
        context.report({
          node,
          messageId: result.messageId,
          ...(result.data !== undefined ? { data: result.data } : {}),
        });
      }
    }

    return {
      ImportDeclaration(node) {
        if (typeof node.source.value === "string") {
          reportIfNeeded(node, node.source.value);
        }
      },
      ExportNamedDeclaration(node) {
        if (node.source !== null && typeof node.source.value === "string") {
          reportIfNeeded(node, node.source.value);
        }
      },
      ExportAllDeclaration(node) {
        if (typeof node.source.value === "string") {
          reportIfNeeded(node, node.source.value);
        }
      },
    };
  },
};
