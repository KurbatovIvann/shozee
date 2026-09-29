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
  modelProblems,
  readManifest,
} from "./manifest.ts";

export {
  InputError,
  RESULT_SCHEMA,
  VERSION as runtimeVersion,
  compileContext,
  tempered,
  type Bundle,
  type Calibration,
  type CommandV2,
  type CompiledContext,
  type Context,
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

export const conformanceDir = join(packageRoot, "test", "conformance-v3");

export const modelInfo: ModelInfo = {
  name: manifest.model,
  md5: manifest.files[ONNX_FILE]?.md5 ?? "",
};

export function checkModel(): Promise<string[]> {
  return modelProblems(modelDir, manifest);
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
  if (options.verify === true) {
    const problems = await modelProblems(dir, manifest);
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
