/**
 * ESM resolve hook so Node type stripping can load
 * NodeNext sources (API/worker start, backup-verify CLI): they import
 * siblings with `.js` specifiers, and type-stripping does not remap
 * those to `.ts` / `.tsx`. Native resolution always wins first (real `.js`
 * files are not shadowed). `.tsx` is required for doc-generation PDF
 * templates (NodeNext `.js` specifiers). Node's type stripper does not
 * execute `.tsx` (unknown extension + JSX), so `load` transpiles those
 * files with the workspace TypeScript compiler (`jsx: react-jsx`).
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { extname } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

const tsExtensions = [".ts", ".mts", ".cts", ".tsx"];
const require = createRequire(import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (
      err?.code !== "ERR_MODULE_NOT_FOUND" ||
      !specifier.endsWith(".js") ||
      context.parentURL === undefined
    ) {
      throw err;
    }
    const targetPath = fileURLToPath(new URL(specifier, context.parentURL));
    const withoutExt = targetPath.slice(0, -extname(targetPath).length);
    for (const ext of tsExtensions) {
      const candidate = withoutExt + ext;
      if (existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
    throw err;
  }
}

export async function load(url, context, nextLoad) {
  const path = url.startsWith("file:") ? fileURLToPath(url) : "";
  if (!path.endsWith(".tsx")) {
    return nextLoad(url, context);
  }
  const ts = require("typescript");
  const source = readFileSync(path, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: path,
  });
  return { format: "module", source: outputText, shortCircuit: true };
}
