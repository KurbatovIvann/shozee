/**
 * A worker-run turn acts as whoever the turn row names, and only the system
 * read of that row can say so (SHO-561). These are compile-time assertions:
 * `tsc --noEmit` fails if a job payload, or a caller assembled by hand, ever
 * becomes assignable to `VerifiedAssistantCaller`.
 */
import { describe, expectTypeOf, it } from "vitest";

import type { AssistantTurnJob } from "../queue.js";
import type {
  AssistantTurnForJob,
  VerifiedAssistantCaller,
} from "./assistant-turn-for-job.js";
import type { AssistantKitCaller } from "./caller.js";

describe("VerifiedAssistantCaller", () => {
  it("is not constructible from a job payload", () => {
    expectTypeOf<AssistantTurnJob>().not.toExtend<VerifiedAssistantCaller>();
    expectTypeOf<
      AssistantTurnJob & AssistantKitCaller
    >().not.toExtend<VerifiedAssistantCaller>();
  });

  it("is not constructible from a caller built by hand, with or without an IP", () => {
    expectTypeOf<AssistantKitCaller>().not.toExtend<VerifiedAssistantCaller>();
    expectTypeOf<{
      readonly userId: string;
      readonly companySelector: string;
      readonly requestId: string;
      readonly clientIp: string;
    }>().not.toExtend<VerifiedAssistantCaller>();
  });

  it("is still a caller every store accepts, and comes only with a read turn", () => {
    expectTypeOf<VerifiedAssistantCaller>().toExtend<AssistantKitCaller>();
    expectTypeOf<
      AssistantTurnForJob["caller"]
    >().toEqualTypeOf<VerifiedAssistantCaller>();
  });
});
