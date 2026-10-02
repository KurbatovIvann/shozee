import type { Now, ResultV2 } from "@showzy/sho";
import type { ShoModelStamp, ShoPrevious } from "@showzy/sho-protocol";

export const SHO_LABELS_FILE = "labels.json";

export class ShoRunFailure extends Error {
  override readonly name = "ShoRunFailure";
}

export interface ShoContextUpload {
  readonly key: string;
  readonly fingerprint: string;
  readonly revision: string | null;
  readonly context: unknown;
  readonly phrases: readonly string[];
  readonly uploadBytes: number;
}

export interface ShoParseJob {
  readonly key: string;
  readonly fingerprint: string;
  readonly text: string;
  readonly now: Now;
  readonly previous: ShoPrevious | null;
  readonly debug: boolean;
  readonly deadlineMs: number;
}

export type ShoWorkerCommand =
  | {
      readonly id: number;
      readonly kind: "store";
      readonly upload: ShoContextUpload;
    }
  | { readonly id: number; readonly kind: "parse"; readonly job: ShoParseJob }
  | { readonly id: number; readonly kind: "phrases"; readonly key: string };

export type ShoWorkerReady = {
  readonly kind: "ready";
  readonly stamp: ShoModelStamp;
  readonly actions: readonly string[];
};

export type ShoWorkerReply =
  | { readonly id: number; readonly kind: "stored" }
  | {
      readonly id: number;
      readonly kind: "parsed";
      readonly result: ResultV2;
      readonly contextRevision: string | null;
      readonly ms: number;
    }
  | {
      readonly id: number;
      readonly kind: "phrases";
      readonly phrases: readonly string[] | null;
    }
  | { readonly id: number; readonly kind: "context_required" }
  | { readonly id: number; readonly kind: "input" }
  | { readonly id: number; readonly kind: "failed"; readonly message: string };

export type ShoSlotRefusal =
  | { readonly id: number; readonly kind: "busy" }
  | { readonly id: number; readonly kind: "deadline" };

export type ShoSlotReply = ShoWorkerReply | ShoSlotRefusal;

export type ShoStoreOutcome =
  | { readonly kind: "stored" }
  | { readonly kind: "busy" }
  | { readonly kind: "input" }
  | { readonly kind: "failed"; readonly message: string };

export type ShoRunOutcome =
  | {
      readonly kind: "ok";
      readonly result: ResultV2;
      readonly contextRevision: string | null;
      readonly ms: number;
    }
  | { readonly kind: "context_required" }
  | { readonly kind: "busy" }
  | { readonly kind: "deadline" }
  | { readonly kind: "input" }
  | { readonly kind: "failed"; readonly message: string };

export interface ShoEngine {
  readonly stamp: ShoModelStamp;
  readonly actions: readonly string[];
  readonly workers: number;
  store(upload: ShoContextUpload): Promise<ShoStoreOutcome>;
  phrases(key: string): Promise<readonly string[] | null>;
  run(job: ShoParseJob): Promise<ShoRunOutcome>;
  dispose(): Promise<void>;
}
