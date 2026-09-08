import { describe, expect, it } from "vitest";
import { COMPANY_SELECTOR_HEADER } from "@showzy/contract";

import { staffAssistantChatHeaders } from "./assistant-chat-headers";

describe("staffAssistantChatHeaders", () => {
  it("sends cookie and x-company-id without a companyId body field", () => {
    expect(
      staffAssistantChatHeaders({
        cookie: "better-auth.session_token=abc",
        companyId: "company-a",
      }),
    ).toEqual({
      cookie: "better-auth.session_token=abc",
      [COMPANY_SELECTOR_HEADER]: "company-a",
    });
  });

  it("omits empty credentials", () => {
    expect(staffAssistantChatHeaders({ cookie: "", companyId: null })).toEqual(
      {},
    );
  });
});
