import { createAnthropicStaffProviderAdapter } from "./provider/anthropic.js";
import type { StaffProviderAdapter } from "./provider/types.js";

const TEST_PROVIDER_MODEL = "unit-test-model";

export const testStaffProvider: StaffProviderAdapter =
  createAnthropicStaffProviderAdapter({
    replyModel: TEST_PROVIDER_MODEL,
    gateModel: TEST_PROVIDER_MODEL,
  });
