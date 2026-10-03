import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-node";
import {
  createNodeRunner,
  loadBundle,
  loadCalibration,
  loadRequirements,
} from "../runtime/src/adapters/node.ts";
import {
  CATALOGUE_V3,
  createRuntime,
  isV3,
  type Bundle,
  type Calibration,
  type Requirements,
  type Runtime,
} from "../runtime/src/index.ts";
import {
  ONNX_FILE,
  ShoIntegrityError,
  fileProblems,
  readManifest,
} from "./manifest.ts";

export {
  CONTEXT_LIMITS,
  FOCUS_PARAM_TYPES,
  InputError,
  MOST_FOCUS,
  RECORD_LISTS,
  RESULT_SCHEMA,
  SALE_UNITS,
  VERSION as runtimeVersion,
  compileContext,
  isContextV2,
  parseContext,
  parseFocus,
  parsePrevious,
  periodDates,
  tempered,
  type ActionName,
  type Bundle,
  type Calibration,
  type CommandV2,
  type CompiledContext,
  type Context,
  type ContextV2,
  type Day,
  type FocusEntry,
  type FocusHow,
  type FocusType,
  type ListName,
  type Now,
  type PeriodDates,
  type Previous,
  type Requirements,
  type ResultV2,
  type RunOptions,
  type Runtime,
} from "../runtime/src/index.ts";
export {
  ShoIntegrityError,
  fileProblems,
  parseManifest,
  type Manifest,
} from "./manifest.ts";

export interface ModelInfo {
  readonly name: string;
  readonly md5: string;
}

export interface LoadOptions {
  readonly threads?: number;
  readonly verify?: boolean;
  readonly dir?: string;
}

export interface Sho extends Runtime {
  readonly model: ModelInfo;
  readonly calibration: Calibration;
  dispose(): Promise<void>;
}

export class ShoBundleError extends Error {
  override readonly name = "ShoBundleError";
}

export const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export const manifest = readManifest(packageRoot);

export const modelDir = join(packageRoot, "model", manifest.model);

export const runtimeDir = join(packageRoot, "runtime", "src");

export const conformanceDir = join(packageRoot, "test", "conformance-v3");

export const modelInfo: ModelInfo = {
  name: manifest.model,
  md5: manifest.files[ONNX_FILE]?.md5 ?? "",
};

export function checkModel(dir = modelDir): Promise<string[]> {
  return fileProblems(dir, manifest.files);
}

export function checkRuntime(): Promise<string[]> {
  return fileProblems(runtimeDir, manifest.runtime);
}

export function assertV3(bundle: Pick<Bundle, "catalogue">, dir: string): void {
  if (!isV3(bundle))
    throw new ShoBundleError(
      `${dir} is not a Шо ${CATALOGUE_V3} bundle (labels.json catalogue: ${JSON.stringify(bundle.catalogue)})`,
    );
}

export async function loadV3Bundle(dir = modelDir): Promise<Bundle> {
  const bundle = await loadBundle(dir);
  assertV3(bundle, dir);
  return bundle;
}

export function requirementsOf(dir = modelDir): Promise<Requirements> {
  return loadRequirements(dir);
}

export function calibrationOf(dir = modelDir): Promise<Calibration> {
  return loadCalibration(dir);
}

export async function loadSho(options: LoadOptions = {}): Promise<Sho> {
  const dir = options.dir ?? modelDir;
  if (options.verify !== false) {
    const checked = await Promise.all([checkModel(dir), checkRuntime()]);
    const problems = checked.flat();
    if (problems.length > 0) throw new ShoIntegrityError(problems);
  }
  const [bundle, requirements, calibration] = await Promise.all([
    loadV3Bundle(dir),
    requirementsOf(dir),
    calibrationOf(dir),
  ]);
  const runner = await createNodeRunner({
    model: dir,
    threads: options.threads ?? 1,
    ort,
  });
  const runtime = createRuntime(bundle, runner, {
    requirements,
    actionTemperature: calibration.actionTemperature,
  });
  const md5 = dir === modelDir ? modelInfo.md5 : (bundle.id?.onnx ?? "");
  return {
    ...runtime,
    model: { name: dir === modelDir ? modelInfo.name : dir, md5 },
    calibration,
    dispose: () => runner.dispose(),
  };
}
