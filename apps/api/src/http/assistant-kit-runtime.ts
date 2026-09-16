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
}

export function createAssistantKitRuntime(
  options: CreateAssistantKitRuntimeOptions,
): AssistantKitRuntime {
  const { auth, ...runtimeOptions } = options;
  return {
    ...createAssistantRuntime(runtimeOptions),
    commands: createRedisAssistantKitCommands(options.redis),
    auth,
  };
}
