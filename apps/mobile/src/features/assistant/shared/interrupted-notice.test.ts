import { describe, expect, it } from "vitest";

import { assistantCopy } from "../../../i18n/assistant";
import { assistantInterruptedNotice } from "./interrupted-notice";

describe("assistantInterruptedNotice", () => {
  it("names a turn that never started, in both locales", () => {
    expect(assistantInterruptedNotice("not_started", assistantCopy("uk"))).toBe(
      "Шозік не встиг розпочати відповідь.",
    );
    expect(assistantInterruptedNotice("not_started", assistantCopy("en"))).toBe(
      "Shozik didn't get to start the reply.",
    );
  });

  it("keeps the generic sentence for a turn that stopped after starting", () => {
    const uk = assistantCopy("uk");
    expect(assistantInterruptedNotice("timeout", uk)).toBe(
      uk.interruptedMessage,
    );
    expect(assistantInterruptedNotice("job_exhausted", uk)).toBe(
      uk.interruptedMessage,
    );
  });

  it("keeps the generic sentence for a turn stored without a reason", () => {
    const uk = assistantCopy("uk");
    expect(assistantInterruptedNotice(null, uk)).toBe(uk.interruptedMessage);
    expect(uk.interruptedNotStarted).not.toBe(uk.interruptedMessage);
  });
});
