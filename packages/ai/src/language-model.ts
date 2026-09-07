import type { LanguageModel } from "ai";

import { createAnthropicStaffProviderAdapter } from "./provider/anthropic.js";

/**
 * Staff-panel language model via the Anthropic adapter. The API key comes
 * from validated config (`ServerConfig.ai`), never from `process.env` in
 * this package. Callers must not invoke this with a missing key — the SSE
 * mount fails typed. HTTP composition prefers
 * `StaffProviderAdapter.createModel`.
 */
export function createStaffLanguageModel(options: {
  readonly apiKey: string;
  readonly model: string;
}): LanguageModel {
  return createAnthropicStaffProviderAdapter({
    apiKey: options.apiKey,
    replyModel: options.model,
    gateModel: options.model,
  }).createModel("reply");
}
