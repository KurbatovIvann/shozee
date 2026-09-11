/**
 * Which language model the assistant runs on, or none.
 *
 * Three sources in order: one a test injected, the configured provider, and a
 * bare api key. `undefined` rather than a throw, because "no model configured"
 * is a deployment shape and not a fault — boot mounts the assistant routes only
 * when there is something for them to call, and says so either way.
 */
import {
  StaffAssistantNotConfiguredError,
  createStaffLanguageModel,
  type LanguageModel,
  type StaffProviderAdapter,
} from "@showzy/ai";

export interface StaffAssistantModelConfig {
  readonly model: string;
  readonly anthropicApiKey?: string;
  /** Constructed once in `apps/api` composition from config (SHO-508). */
  readonly provider?: StaffProviderAdapter;
  /** Tests inject a mock model — never a live LLM in CI. */
  readonly languageModel?: LanguageModel;
}

function tryCreateProviderModel(
  provider: StaffProviderAdapter | undefined,
): LanguageModel | undefined {
  if (provider === undefined) {
    return undefined;
  }
  try {
    return provider.createModel("reply");
  } catch (error) {
    // A provider that cannot build a model is the same answer as no provider.
    if (error instanceof StaffAssistantNotConfiguredError) {
      return undefined;
    }
    throw error;
  }
}

export function optionalStaffAssistantLanguageModel(
  assistant: StaffAssistantModelConfig | undefined,
): LanguageModel | undefined {
  if (assistant?.languageModel !== undefined) {
    return assistant.languageModel;
  }
  const fromProvider = tryCreateProviderModel(assistant?.provider);
  if (fromProvider !== undefined) {
    return fromProvider;
  }
  if (
    assistant !== undefined &&
    assistant.anthropicApiKey !== undefined &&
    assistant.anthropicApiKey !== ""
  ) {
    return createStaffLanguageModel({
      apiKey: assistant.anthropicApiKey,
      model: assistant.model,
    });
  }
  return undefined;
}
