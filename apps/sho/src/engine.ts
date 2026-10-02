import {
  compileContext,
  loadSho,
  manifest,
  runtimeVersion,
  type CompiledContext,
  type Context,
  type Now,
  type Previous,
  type ResultV2,
  type Sho,
} from "@showzy/sho";
import type { ShoModelStamp } from "@showzy/sho-protocol";

export const SHO_LABELS_FILE = "labels.json";

export interface ShoParseJob {
  readonly text: string;
  readonly context: CompiledContext;
  readonly now: Now;
  readonly previous: Previous | null;
  readonly debug: boolean;
}

export interface ShoEngine {
  readonly stamp: ShoModelStamp;
  readonly actions: readonly string[];
  readonly workers: number;
  compile(context: Context): CompiledContext;
  run(job: ShoParseJob): Promise<ResultV2>;
  dispose(): Promise<void>;
}

export function shoEngineOf(sho: Sho): ShoEngine {
  return {
    stamp: {
      id: sho.model.name,
      md5: sho.model.md5,
      catalogue: sho.bundle.catalogue ?? "",
      labelsMd5: manifest.files[SHO_LABELS_FILE]?.md5 ?? "",
      runtime: runtimeVersion,
    },
    actions: sho.bundle.actions,
    workers: 1,
    compile: compileContext,
    run: ({ text, context, now, previous, debug }) =>
      sho.run({ raw: text }, { context, now, previous, debug }),
    dispose: () => sho.dispose(),
  };
}

export async function loadShoEngine(): Promise<ShoEngine> {
  return shoEngineOf(await loadSho());
}
