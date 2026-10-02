import type { Now, ResultV2 } from "@showzy/sho";
import type { ShoModelStamp, ShoPrevious } from "@showzy/sho-protocol";

export const SHO_LABELS_FILE = "labels.json";

export class ShoRunFailure extends Error {
  override readonly name = "ShoRunFailure";
  readonly code: string;

  constructor(code: string) {
    super("sho worker run failed");
    this.code = code;
  }
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

export interface ShoWorkerSetup {
  readonly maxUploadBytes: number;
}

export type ShoReply =
  | { readonly kind: "stored" }
  | {
      readonly kind: "parsed";
      readonly result: ResultV2;
      readonly contextRevision: string | null;
      readonly ms: number;
    }
  | { readonly kind: "phrases"; readonly phrases: readonly string[] | null }
  | { readonly kind: "context_required" }
  | { readonly kind: "busy" }
  | { readonly kind: "deadline" }
  | { readonly kind: "input" }
  | { readonly kind: "failed"; readonly code: string };

type ShoRefusalKind = "busy" | "deadline" | "failed";

export type ShoStoreReply = Extract<
  ShoReply,
  { kind: "stored" | "input" | ShoRefusalKind }
>;

export type ShoPhrasesReply = Extract<
  ShoReply,
  { kind: "phrases" | ShoRefusalKind }
>;

export type ShoRunReply = Extract<
  ShoReply,
  { kind: "parsed" | "context_required" | "input" | ShoRefusalKind }
>;

export interface ShoFailureDetail {
  readonly message: string;
  readonly stack: string | null;
}

export interface ShoAnswer {
  readonly id: number;
  readonly reply: ShoReply;
  readonly detail?: ShoFailureDetail | undefined;
}

export type ShoWorkerCommand =
  | {
      readonly id: number;
      readonly kind: "store";
      readonly upload: ShoContextUpload;
    }
  | { readonly id: number; readonly kind: "parse"; readonly job: ShoParseJob }
  | { readonly id: number; readonly kind: "phrases"; readonly key: string };

export interface ShoWorkerReady {
  readonly kind: "ready";
  readonly stamp: ShoModelStamp;
  readonly actions: readonly string[];
}

export interface ShoEngine {
  readonly stamp: ShoModelStamp;
  readonly actions: readonly string[];
  readonly workers: number;
  readonly ready: boolean;
  store(upload: ShoContextUpload): Promise<ShoStoreReply>;
  phrases(key: string): Promise<ShoPhrasesReply>;
  run(job: ShoParseJob): Promise<ShoRunReply>;
  dispose(): Promise<void>;
}
