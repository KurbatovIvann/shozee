/**
 * The assistant the routes mount: the shared runtime from
 * `@showzy/assistant-runtime` (ADR-0039), plus the session lookup and the
 * command receipts, which belong to a request and not to a turn.
 */
import {
  createAssistantRuntime,
  createRedisAssistantKitCommands,
  type CreateAssistantRuntimeOptions,
} from "@showzy/assistant-runtime";

import type { AssistantKitRuntime } from "./assistant-kit-http.js";

export interface CreateAssistantKitRuntimeOptions extends CreateAssistantRuntimeOptions {
  readonly auth: AssistantKitRuntime["auth"];
  /**
   * The assistant queue this process produces onto (SHO-563), on the dedicated
   * queue Redis. Absent, an accepted turn is stored and left for the
   * reconciler to enqueue — which is what a test without a queue wants, and
   * never a silent loss.
   */
  readonly queue?: AssistantKitRuntime["queue"];
}

export function createAssistantKitRuntime(
  options: CreateAssistantKitRuntimeOptions,
): AssistantKitRuntime {
  const { auth, queue, ...runtimeOptions } = options;
  return {
    ...createAssistantRuntime(runtimeOptions),
    commands: createRedisAssistantKitCommands(options.redis),
    auth,
    ...(queue === undefined ? {} : { queue }),
  };
}
