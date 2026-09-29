import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseBundle, type Bundle, type BundleId } from "../bundle.ts";
import { parseRequirements, type Requirements } from "../command.ts";
import { UNCALIBRATED, parseCalibration, type Calibration } from "../confidence.ts";
import { BundleError, ModelError } from "../errors.ts";
import type { ModelRunner } from "../model.ts";
import { ortRunner, type OrtSessionLike, type OrtTensorConstructor } from "./ort.ts";

export type NodeVariant = "int8" | "fp32";

export interface NodeSessionOptions {
  readonly executionProviders: readonly string[];
  readonly graphOptimizationLevel: "all";
  readonly intraOpNumThreads: number;
  readonly interOpNumThreads: number;
}

export interface OrtNodeLike {
  readonly Tensor: OrtTensorConstructor;
  readonly InferenceSession: { create(path: string, options: NodeSessionOptions): Promise<OrtSessionLike> };
}

export interface NodeModelOptions {
  readonly model: string;
  readonly variant?: NodeVariant;
  readonly threads?: number;
  readonly ort?: OrtNodeLike;
}

export const MODEL_FILES: Readonly<Record<NodeVariant, string>> = { int8: "model.int8.onnx", fp32: "model.onnx" };
export const LABELS_FILE = "labels.json";
export const TOKENIZER_FILE = "tokenizer.json";
// The bundle's intent catalogue: titles for the demo, and which params each intent requires (`parseRequirements`).
export const INTENT_CATALOGUE_FILE = "intent_labels_uk.json";
// D87: the bundle's calibration (`parseCalibration`); a bundle without it serves the raw confidence.
export const CALIBRATION_FILE = "calibration.json";

const ORT_NODE = "onnxruntime-node";

export function isNodeVariant(value: string): value is NodeVariant {
  return Object.hasOwn(MODEL_FILES, value);
}

export function sessionOptions(threads: number): NodeSessionOptions {
  if (!Number.isInteger(threads) || threads < 1) throw new ModelError("threads", `intra-op threads must be a positive integer, got ${threads}`);
  return { executionProviders: ["cpu"], graphOptimizationLevel: "all", intraOpNumThreads: threads, interOpNumThreads: 1 };
}

function isOrtNode(value: unknown): value is OrtNodeLike {
  if (typeof value !== "object" || value === null) return false;
  const session: unknown = Reflect.get(value, "InferenceSession");
  return typeof Reflect.get(value, "Tensor") === "function" && typeof session === "function" && typeof Reflect.get(session, "create") === "function";
}

export async function loadOrtNode(): Promise<OrtNodeLike> {
  let loaded: unknown;
  try {
    loaded = await import(ORT_NODE);
  } catch (error) {
    throw new ModelError("runner_missing", `${ORT_NODE} is not installed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isOrtNode(loaded)) throw new ModelError("runner_missing", `${ORT_NODE} does not export InferenceSession and Tensor`);
  return loaded;
}

export async function createNodeRunner(options: NodeModelOptions): Promise<ModelRunner> {
  const settings = sessionOptions(options.threads ?? 1);
  const ort = options.ort ?? (await loadOrtNode());
  const path = join(options.model, MODEL_FILES[options.variant ?? "int8"]);
  try {
    return ortRunner(ort.Tensor, await ort.InferenceSession.create(path, settings));
  } catch (error) {
    throw new ModelError("session", `cannot open ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function fileBytes(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch {
    throw new BundleError("bundle_file", `cannot read ${path}`);
  }
}

async function fileMd5(path: string): Promise<string> {
  const hash = createHash("md5");
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk);
  } catch {
    throw new BundleError("bundle_file", `cannot read ${path}`);
  }
  return hash.digest("hex");
}

function md5(bytes: Buffer): string {
  return createHash("md5").update(bytes).digest("hex");
}

function json(bytes: Buffer, path: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new BundleError("bundle_json", `${path} is not JSON`);
  }
}

export async function loadBundle(dir: string, variant: NodeVariant = "int8"): Promise<Bundle> {
  const labelsPath = join(dir, LABELS_FILE);
  const tokenizerPath = join(dir, TOKENIZER_FILE);
  const [labels, tokenizer, onnx] = await Promise.all([fileBytes(labelsPath), fileBytes(tokenizerPath), fileMd5(join(dir, MODEL_FILES[variant]))]);
  const id: BundleId = { onnx, tokenizer: md5(tokenizer), labels: md5(labels) };
  return parseBundle(json(labels, labelsPath), json(tokenizer, tokenizerPath), id);
}

// What the bundle's intent catalogue requires of each action's params; none when the bundle has no catalogue.
export async function loadRequirements(dir: string): Promise<Requirements> {
  const path = join(dir, INTENT_CATALOGUE_FILE);
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    return {};
  }
  return parseRequirements(json(bytes, path));
}

// The temperature of the bundle's action head (D87); T = 1 when the bundle has no calibration file.
export async function loadCalibration(dir: string): Promise<Calibration> {
  const path = join(dir, CALIBRATION_FILE);
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    return UNCALIBRATED;
  }
  return parseCalibration(json(bytes, path));
}
