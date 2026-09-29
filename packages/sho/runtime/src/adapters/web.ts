import type { ModelRunner } from "../model.ts";
import { ortRunner, type OrtSessionLike, type OrtTensorConstructor } from "./ort.ts";

export type { OrtSessionLike, OrtTensorLike } from "./ort.ts";

export interface OrtSessionOptions {
  readonly executionProviders: readonly string[];
  readonly graphOptimizationLevel: "all";
}

export interface OrtLike {
  readonly env: { readonly wasm: { wasmPaths?: unknown; numThreads?: number } };
  readonly Tensor: OrtTensorConstructor;
  readonly InferenceSession: { create(path: string, options: OrtSessionOptions): Promise<OrtSessionLike> };
}

export type WebVariant = "int8" | "fp32";

export interface WebModelOptions {
  readonly ort: OrtLike;
  readonly model: string;
  readonly wasmPaths: string;
  readonly variant?: WebVariant | null;
}

export interface WebModel {
  readonly runner: ModelRunner;
  readonly variant: WebVariant;
  readonly fallback: unknown;
}

const SESSION_OPTIONS: OrtSessionOptions = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
const FILES: Readonly<Record<WebVariant, string>> = { int8: "model.int8.onnx", fp32: "model.onnx" };

export function webRunner(ort: OrtLike, session: OrtSessionLike): ModelRunner {
  return ortRunner(ort.Tensor, session);
}

export async function createWebRunner(options: WebModelOptions): Promise<WebModel> {
  const { ort } = options;
  ort.env.wasm.wasmPaths = options.wasmPaths;
  ort.env.wasm.numThreads = 1;
  const open = async (variant: WebVariant): Promise<WebModel> => ({ runner: webRunner(ort, await ort.InferenceSession.create(`${options.model}/${FILES[variant]}`, SESSION_OPTIONS)), variant, fallback: null });
  if (options.variant) return open(options.variant);
  try {
    return await open("int8");
  } catch (error) {
    return { ...(await open("fp32")), fallback: error };
  }
}
