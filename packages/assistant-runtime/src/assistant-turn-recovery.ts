import type { ActionPipelineDeps } from "@showzy/core";
import { CoreError } from "@showzy/core/errors";
import type { AssistantTurnEndReason } from "@showzy/validation/assistant-chat";
import type { Logger } from "pino";

import {
  releaseStaffAssistantBudgetHold,
  type StaffAssistantBudgetHold,
} from "./assistant-budget-guard.js";
import type { AssistantKitScoped } from "./runtime-types.js";
import type { AssistantEventPublisher } from "./stores/assistant-events-redis.js";
import { createPostgresInterruptedTurnAuthor } from "./stores/assistant-turn-for-job.js";
import { readTurnPlaceholderBind } from "./stores/assistant-turn-placeholder.js";
import type { AssistantTurnRef } from "./stores/assistant-turn-store.js";
import type { AiBudgetStore } from "./stores/budget.js";
import type { AssistantKitCaller } from "./stores/caller.js";

export interface AssistantRecoveredTurn {
  readonly companyId: string;
  readonly turn: AssistantTurnRef;
  readonly from: "queued" | "running";
  readonly endReason: AssistantTurnEndReason;
  readonly releasedHold: StaffAssistantBudgetHold;
}

export interface AssistantRecoveryAuthor {
  readonly kit: {
    readonly messages: Pick<AssistantKitScoped["kit"]["messages"], "write">;
  };
}

export interface AssistantTurnRecoveryDeps {
  readonly pipeline: ActionPipelineDeps;
  readonly logger: Logger;
  readonly forCaller: (caller: AssistantKitCaller) => AssistantRecoveryAuthor;
  readonly publisher: AssistantEventPublisher;
  readonly budgetStore?: AiBudgetStore | undefined;
}

export type AssistantTurnRecovery = (
  ended: AssistantRecoveredTurn,
  requestId: string,
) => Promise<void>;

export function createAssistantTurnRecovery(
  deps: AssistantTurnRecoveryDeps,
): AssistantTurnRecovery {
  const storeDeps = { pipeline: deps.pipeline };
  const authors = createPostgresInterruptedTurnAuthor(storeDeps);
  const { logger } = deps;

  async function settlePlaceholder(
    ended: AssistantRecoveredTurn,
    requestId: string,
    fields: Record<string, string>,
  ): Promise<void> {
    try {
      const author = await authors.read({
        companyId: ended.companyId,
        turn: ended.turn,
        requestId,
      });
      const bind =
        author === null
          ? null
          : await readTurnPlaceholderBind(storeDeps, author.caller, {
              conversationId: ended.turn.conversationId,
              placeholderMessageId: author.placeholderMessageId,
            });
      if (author === null || bind === null) {
        logger.warn(fields, "assistant turn text was not ended");
        return;
      }
      const written = await deps.forCaller(author.caller).kit.messages.write(
        { conversationId: ended.turn.conversationId, bind },
        {
          kind: "end_text",
          messageId: author.placeholderMessageId,
          status: "interrupted",
        },
      );
      if (written.kind !== "written" && written.kind !== "unchanged") {
        logger.warn(
          { ...fields, refusal: written.kind },
          "assistant turn text was not ended",
        );
      }
    } catch (error) {
      logger.warn(
        {
          ...fields,
          ...(error instanceof CoreError ? { code: error.code } : {}),
        },
        "assistant turn text was not ended",
      );
    }
  }

  return async (ended, requestId) => {
    const fields = {
      request_id: requestId,
      conversation_id: ended.turn.conversationId,
      turn_kind: ended.turn.kind,
      end_reason: ended.endReason,
    };
    if (ended.from === "queued") {
      await releaseStaffAssistantBudgetHold({
        logger,
        requestId,
        ref: { companyId: ended.companyId, ...ended.turn },
        hold: ended.releasedHold,
        budgetStore: deps.budgetStore,
      });
    }
    await settlePlaceholder(ended, requestId, fields);
    try {
      await deps.publisher.publish(
        {
          companyId: ended.companyId,
          conversationId: ended.turn.conversationId,
        },
        {
          type: "turn.finished",
          kind: ended.turn.kind,
          commandId: ended.turn.commandId,
          status: "interrupted",
        },
      );
    } catch (error) {
      logger.warn(
        { ...fields, err: error },
        "assistant event was not published",
      );
    }
  };
}
