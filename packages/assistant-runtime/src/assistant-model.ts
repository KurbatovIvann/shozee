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
  createAnthropicStaffProviderAdapter,
  createStaffLanguageModel,
  type LanguageModel,
  type StaffProviderAdapter,
} from "@showzy/ai";
import type { Logger } from "pino";

/** The slice of validated config (`ServerConfig["ai"]`) the assistant needs. */
export interface StaffAssistantAiConfig {
  readonly assistantKitEnabled: boolean;
  readonly anthropicApiKey: string | undefined;
  readonly model: string;
  readonly gateModel: string;
}

/**
 * Staff-assistant provider from validated process config (SHO-508). Each
 * process builds it once, from its own config, here — never through
 * `@showzy/api` (SHO-569).
 */
export function createStaffAssistantProvider(
  ai: Pick<StaffAssistantAiConfig, "anthropicApiKey" | "model" | "gateModel">,
): StaffProviderAdapter {
  return createAnthropicStaffProviderAdapter({
    ...(ai.anthropicApiKey !== undefined ? { apiKey: ai.anthropicApiKey } : {}),
    replyModel: ai.model,
    gateModel: ai.gateModel,
  });
}

/** Whether this process runs the assistant, and on what. */
export interface StaffAssistantMount {
  readonly enabled: boolean;
  readonly provider: StaffProviderAdapter;
  /** Undefined: the assistant is not mounted in this process. */
  readonly model: LanguageModel | undefined;
}

/**
 * The one rule both processes mount the assistant by: on unless
 * `AI_ASSISTANT_KIT=0`, and off with no language model to call. The API mounts
 * its routes and the worker its queue on the same answer, so a worker never
 * runs turns an API would not accept, and the reverse.
 */
export function staffAssistantMount(
  ai: StaffAssistantAiConfig,
): StaffAssistantMount {
  const provider = createStaffAssistantProvider(ai);
  const model = ai.assistantKitEnabled
    ? optionalStaffAssistantLanguageModel({
        model: ai.model,
        provider,
        ...(ai.anthropicApiKey !== undefined
          ? { anthropicApiKey: ai.anthropicApiKey }
          : {}),
      })
    : undefined;
  return { enabled: ai.assistantKitEnabled, provider, model };
}

/**
 * Logged either way, by both processes. A path that can be off for two
 * different reasons and says nothing is a path you cannot tell is running.
 */
export function logStaffAssistantMount(
  logger: Pick<Logger, "info">,
  mount: StaffAssistantMount,
  paths: readonly string[],
): void {
  logger.info(
    {
      enabled: mount.enabled,
      mounted: mount.model !== undefined,
      paths: mount.model === undefined ? [] : paths,
      ...(mount.enabled && mount.model === undefined
        ? { reason: "no language model configured" }
        : {}),
    },
    "assistant-kit path",
  );
}

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
