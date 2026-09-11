import { describe, expect, it } from "vitest";

import {
  StaffAssistantNotConfiguredError,
  StaffAssistantProviderError,
} from "./errors.js";

describe("StaffAssistantNotConfiguredError", () => {
  it("is a typed request-time failure with a stable code", () => {
    const error = new StaffAssistantNotConfiguredError();
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("AI_NOT_CONFIGURED");
    expect(error.message).toBe("Staff assistant is not configured.");
    expect(error.name).toBe("StaffAssistantNotConfiguredError");
  });
});

describe("StaffAssistantProviderError", () => {
  it("is a typed request-time failure with a stable code", () => {
    const cause = new Error("messages.7.content.1.tool_use.id");
    const error = new StaffAssistantProviderError(cause);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("AI_PROVIDER_ERROR");
    expect(error.message).toBe("The assistant could not complete this turn.");
    expect(error.name).toBe("StaffAssistantProviderError");
    expect(error.cause).toBe(cause);
  });
});
