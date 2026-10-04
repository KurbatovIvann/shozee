/**
 * SHO-330: one contract data path. Views/routes never `fetch` domain data
 * or construct a second client; invalidations stay keyed; no second cache.
 *
 * SHO-421: path matching is POSIX-only after `toPosix`. This host is Linux;
 * Windows `join()` separators are simulated in the unit cases below.
 */
// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertWalkSkipsLintProbes,
  TRANSIENT_LINT_PROBE_DIR,
} from "@showzy/tooling/lint-probe";
import { describe, expect, it } from "vitest";

import {
  isProductionSource,
  scanContractDataPath,
  toPosix,
} from "./data-flow-contract";

const here = dirname(fileURLToPath(import.meta.url));
const webSrc = join(here, "..");
const webSrcPosix = toPosix(webSrc);

function listFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === TRANSIENT_LINT_PROBE_DIR) {
      continue;
    }
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function productionSources(): string[] {
  return listFiles(webSrc).map(toPosix).filter(isProductionSource);
}

function readPosix(filePosix: string): string {
  return readFileSync(filePosix, "utf8");
}

describe("src walk and transient lint probes (SHO-863)", () => {
  it("never reads a file the boundary suite writes and deletes", () => {
    assertWalkSkipsLintProbes(listFiles);
  });
});

describe("web contract data path (SHO-330)", () => {
  const files = productionSources();
  const scan = scanContractDataPath(files, webSrcPosix, readPosix);

  it("keeps fetch and client construction on the shared oRPC adapter", () => {
    expect(scan.fetchFiles).toEqual([toPosix(join(webSrc, "api/client.ts"))]);

    expect(scan.constructorFiles.toSorted()).toEqual(
      [
        toPosix(join(webSrc, "api/client.ts")),
        toPosix(join(webSrc, "app/runtime.ts")),
      ].toSorted(),
    );
  });

  it("does not import the contract client from routes, layouts, or views", () => {
    expect(scan.forbiddenClientImportFiles).toEqual([]);
  });

  it("never issues an unqualified cache invalidate or a Zustand store", () => {
    for (const file of files) {
      const text = readPosix(file);
      expect(text).not.toMatch(/invalidateQueries\(\s*\)/);
      expect(text).not.toMatch(/from ["']zustand["']/);
    }
  });
});

describe("path normalization (SHO-421)", () => {
  const windowsWebSrc = "C:\\repo\\apps\\web\\src";
  const posixWebSrc = toPosix(windowsWebSrc);

  it("toPosix converts Windows separators and leaves POSIX paths unchanged", () => {
    expect(toPosix("apps/web/src/api/client.ts")).toBe(
      "apps/web/src/api/client.ts",
    );
    expect(toPosix("apps\\web\\src\\api\\client.ts")).toBe(
      "apps/web/src/api/client.ts",
    );
    expect(toPosix(windowsWebSrc)).toBe("C:/repo/apps/web/src");
  });

  it("POSIX-only predicates miss native Windows join() paths until toPosix", () => {
    const testFile = `${windowsWebSrc}\\test\\render.tsx`;
    const generated = `${windowsWebSrc}\\routeTree.gen.ts`;
    const rel = "api\\client.ts";
    const featureApi = "features\\orders\\api\\list.ts";

    expect(testFile.includes("/test/")).toBe(false);
    expect(generated.endsWith("/routeTree.gen.ts")).toBe(false);
    expect(rel.startsWith("api/")).toBe(false);
    expect(/\/api\//.test(featureApi)).toBe(false);

    expect(toPosix(testFile).includes("/test/")).toBe(true);
    expect(toPosix(generated).endsWith("/routeTree.gen.ts")).toBe(true);
    expect(toPosix(rel).startsWith("api/")).toBe(true);
    expect(/\/api\//.test(toPosix(featureApi))).toBe(true);
  });

  it("production-source exclusions match after Windows join() separators", () => {
    const collected = [
      `${windowsWebSrc}\\api\\client.ts`,
      `${windowsWebSrc}\\app\\runtime.ts`,
      `${windowsWebSrc}\\test\\render.tsx`,
      `${windowsWebSrc}\\routeTree.gen.ts`,
      `${windowsWebSrc}\\features\\orders\\list\\orders-list-view.tsx`,
      `${windowsWebSrc}\\features\\orders\\list\\orders-list.presenter.test.ts`,
    ];
    expect(collected.map(toPosix).filter(isProductionSource)).toEqual([
      `${posixWebSrc}/api/client.ts`,
      `${posixWebSrc}/app/runtime.ts`,
      `${posixWebSrc}/features/orders/list/orders-list-view.tsx`,
    ]);
  });

  it("client-import allowlist matches after Windows join() separators", () => {
    const files = [
      `${windowsWebSrc}\\api\\client.ts`,
      `${windowsWebSrc}\\app\\providers.tsx`,
      `${windowsWebSrc}\\app\\router.tsx`,
      `${windowsWebSrc}\\features\\orders\\api\\list.ts`,
      `${windowsWebSrc}\\features\\orders\\list\\orders-list-view.tsx`,
      `${windowsWebSrc}\\layouts\\panel\\panel-layout.tsx`,
      `${windowsWebSrc}\\routes\\_authed\\route.tsx`,
    ].map(toPosix);
    const texts = Object.fromEntries(
      files.map((file) => [
        file,
        `import { createShowzyClient } from "../api/client"`,
      ]),
    );
    const scan = scanContractDataPath(
      files.filter(isProductionSource),
      posixWebSrc,
      (file) => texts[file] ?? "",
    );
    expect(scan.forbiddenClientImportFiles).toEqual([
      `${posixWebSrc}/features/orders/list/orders-list-view.tsx`,
      `${posixWebSrc}/layouts/panel/panel-layout.tsx`,
      `${posixWebSrc}/routes/_authed/route.tsx`,
    ]);
  });

  it("createShowzyClient in a view still fails the guard on POSIX and Windows separators", () => {
    const clientFile = `${posixWebSrc}/api/client.ts`;
    const runtimeFile = `${posixWebSrc}/app/runtime.ts`;
    const viewPosix = `${posixWebSrc}/features/orders/list/orders-list-view.tsx`;
    const texts: Record<string, string> = {
      [clientFile]: "fetch();\ncreateShowzyClient()",
      [runtimeFile]: "createShowzyClient()",
      [viewPosix]: "createShowzyClient()",
    };
    const posixFiles = [clientFile, runtimeFile, viewPosix];
    const posixScan = scanContractDataPath(
      posixFiles,
      posixWebSrc,
      (file) => texts[file] ?? "",
    );
    expect(posixScan.constructorFiles).toEqual([
      clientFile,
      runtimeFile,
      viewPosix,
    ]);

    const windowsFiles = posixFiles.map((file) => file.replaceAll("/", "\\"));
    const windowsScan = scanContractDataPath(
      windowsFiles.map(toPosix),
      toPosix(posixWebSrc.replaceAll("/", "\\")),
      (file) => texts[file] ?? "",
    );
    expect(windowsScan).toEqual(posixScan);
  });

  it("live scan reports the same violation sets for POSIX and simulated Windows separators", () => {
    const posixFiles = productionSources();
    const posixScan = scanContractDataPath(posixFiles, webSrcPosix, readPosix);
    const windowsScan = scanContractDataPath(
      posixFiles.map((file) => toPosix(file.replaceAll("/", "\\"))),
      toPosix(webSrcPosix.replaceAll("/", "\\")),
      readPosix,
    );
    expect(windowsScan).toEqual(posixScan);
    expect(posixScan.forbiddenClientImportFiles).toEqual([]);
    expect(posixScan.fetchFiles).toEqual([
      toPosix(join(webSrc, "api/client.ts")),
    ]);
    expect(posixScan.constructorFiles.toSorted()).toEqual(
      [
        toPosix(join(webSrc, "api/client.ts")),
        toPosix(join(webSrc, "app/runtime.ts")),
      ].toSorted(),
    );
  });
});
