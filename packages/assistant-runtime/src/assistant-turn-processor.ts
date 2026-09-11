/**
 * What the worker does with an accepted turn (ADR-0039, SHO-569).
 *
 * A job names a turn and nothing else, so everything here starts from the turn
 * row: `assistant.readTurnForJob` gives the company, the author, the request the
 * turn is audited under, the placeholder it writes into, and — only while the
 * turn is still queued — the caller it runs as. No session is read; core checks
 * the author's membership again on every action the turn runs.
 *
 * The order is the protocol:
 *
 * 1. A turn that is not queued, or whose start core refuses, runs nothing and
 *    writes nothing. A replayed or duplicate job lands here, and so does a turn
 *    whose author lost membership: it stays queued. How such a turn is closed
 *    is an open owner question (SHO-569), not something this file decides.
 * 2. Started, the turn runs from its conversation's history — a chat turn and
 *    an answer turn alike — with its own 180 s deadline as the only abort. Its
 *    tools derive idempotency keys from the continuation root's command, so
 *    Продовжити replays a write the dead turn committed (SHO-547).
 * 3. The placeholder's `streaming` text is always ended: by the host's own end
 *    write, or here when the turn produced no text. The turn's status is read
 *    back from what was stored, so the message and the turn row cannot say two
 *    different things about how it ended.
 * 4. Anything that throws once the turn has started ends it `interrupted`, with
 *    what it stored standing. A started turn is never run again.
 * 5. `finishTurn` hands back the hold it took off the row. That hold is released
 *    only when the model was never reached; otherwise the reservation stands as
 *    the charge.
 *
 * Every event is published after the write it reports, read back as the turn's
 * author, so `message.updated` carries the stored revision. A lost event costs
 * nothing — every stream starts from a snapshot — so a publish never fails the
 * turn.
 */
import { randomUUID } from "node:crypto";

import {
  MessageWriteRefusedError,
  runHostTurn,
  type ChatPart,
  type ChatWindowMessage,
  type PauseScope,
} from "@showzy/assistant-kit";
import type { ActionPipelineDeps } from "@showzy/core";
import { CoreError, CoreInvariantError } from "@showzy/core/errors";
import type { AssistantPublishedEvent } from "@showzy/validation/assistant-events";

import { releaseStaffAssistantBudgetHold } from "./assistant-budget-guard.js";
import type { AssistantConversationAddress } from "./events.js";
import { ASSISTANT_TURN_TIMEOUT_MS, type AssistantTurnJob } from "./queue.js";
import type { AssistantKitFor, AssistantRuntime } from "./runtime-types.js";
import type { AssistantEventPublisher } from "./stores/assistant-events-redis.js";
import { createPostgresAssistantKitMessageLog } from "./stores/assistant-kit-postgres-stores.js";
import {
  createPostgresAssistantTurnForJob,
  type AssistantTurnForJob,
  type VerifiedAssistantCaller,
} from "./stores/assistant-turn-for-job.js";
import { createPostgresAssistantTurnStore } from "./stores/assistant-turn-store.js";
import type { AiBudgetStore } from "./stores/budget.js";

export type AssistantTurnEndStatus = "done" | "failed" | "interrupted";

type TextStatus = Extract<ChatPart, { kind: "text" }>["status"];

/** How the stored text part reads as the turn's own status. */
const TURN_STATUS_OF_TEXT: Readonly<
  Record<TextStatus, AssistantTurnEndStatus>
> = {
  complete: "done",
  error: "failed",
  interrupted: "interrupted",
  // Unreachable once the text is ended; a turn that could not end it did
  // not finish.
  streaming: "interrupted",
};

/**
 * Arms the turn's deadline and returns its disarm. The only thing that aborts
 * a turn; injected so a test fires it at a point it chooses, never on a clock.
 */
export type AssistantTurnDeadline = (
  abort: () => void,
  ms: number,
) => () => void;

export interface AssistantTurnProcessorDeps {
  readonly runtime: AssistantRuntime;
  readonly pipeline: ActionPipelineDeps;
  /** The T4 publisher, on the shared Redis. */
  readonly publisher: AssistantEventPublisher;
  /** The counters the accept reserved on. Absent: nothing to release. */
  readonly budgetStore?: AiBudgetStore;
  readonly timeoutMs?: number;
  readonly deadline?: AssistantTurnDeadline;
  /** The worker's own request id for reading the turn. */
  readonly newRequestId?: () => string;
}

export type AssistantTurnJobOutcome =
  /** No turn has this identity. */
  | { readonly kind: "no_turn" }
  /** Running or ended already: a replayed or duplicate job. Nothing ran. */
  | { readonly kind: "not_queued"; readonly status: string }
  /** Core refused to start it as its author. Nothing ran; it stays queued. */
  | { readonly kind: "refused"; readonly code: string }
  | {
      readonly kind: "finished";
      readonly status: AssistantTurnEndStatus;
      /** Whether the model was reached, and so whether the hold was kept. */
      readonly reachedModel: boolean;
    }
  /** Something else ended the turn first; this run took no hold. */
  | { readonly kind: "already_finished"; readonly status: string };

const armTimer: AssistantTurnDeadline = (abort, ms) => {
  const timer = setTimeout(abort, ms);
  return () => {
    clearTimeout(timer);
  };
};

function lastTextStatus(
  message: ChatWindowMessage | undefined,
): TextStatus | undefined {
  const texts = (message?.parts ?? []).flatMap((part) =>
    part.kind === "text" ? [part.status] : [],
  );
  return texts.at(-1);
}

export function createAssistantTurnProcessor(
  deps: AssistantTurnProcessorDeps,
): (job: AssistantTurnJob) => Promise<AssistantTurnJobOutcome> {
  const storeDeps = { pipeline: deps.pipeline };
  const forJob = createPostgresAssistantTurnForJob(storeDeps);
  const logger = deps.runtime.logger;
  const timeoutMs = deps.timeoutMs ?? ASSISTANT_TURN_TIMEOUT_MS;
  const deadline = deps.deadline ?? armTimer;
  const newRequestId = deps.newRequestId ?? (() => randomUUID());

  /** Log fields that name the turn and never what anyone wrote. */
  function fieldsOf(found: AssistantTurnForJob, requestId: string) {
    return {
      request_id: requestId,
      conversation_id: found.turn.conversationId,
      turn_kind: found.turn.kind,
    };
  }

  function eventsFor(
    address: AssistantConversationAddress,
    fields: Record<string, string>,
  ) {
    async function publish(event: AssistantPublishedEvent): Promise<void> {
      try {
        await deps.publisher.publish(address, event);
      } catch (error) {
        logger.warn(
          { ...fields, event_type: event.type, err: error },
          "assistant event was not published",
        );
      }
    }

    /** Read as the author after a write, so the event carries what is stored. */
    async function read(kit: AssistantKitFor, scope: PauseScope) {
      try {
        return await kit.messages.read(scope);
      } catch (error) {
        logger.warn(
          { ...fields, err: error },
          "assistant window could not be read for an event",
        );
        return null;
      }
    }

    return {
      publish,
      async messageUpdated(
        kit: AssistantKitFor,
        scope: PauseScope,
        messageId: string,
      ): Promise<void> {
        const message = (await read(kit, scope))?.messages.find(
          (candidate) => candidate.messageId === messageId,
        );
        if (message !== undefined) {
          await publish({
            type: "message.updated",
            conversationId: scope.conversationId,
            message,
          });
        }
      },
      async finished(
        kit: AssistantKitFor,
        scope: PauseScope,
        found: AssistantTurnForJob,
        status: AssistantTurnEndStatus,
      ): Promise<void> {
        const window = await read(kit, scope);
        if (window !== null) {
          await publish({
            type: "turn.finished",
            kind: found.turn.kind,
            commandId: found.turn.commandId,
            status,
            window,
          });
        }
      },
    };
  }

  type TurnEvents = ReturnType<typeof eventsFor>;

  /** The kit the host writes through: each stored write is then reported. */
  function publishing(
    kit: AssistantKitFor,
    events: TurnEvents,
    messageId: string,
  ): AssistantKitFor {
    return {
      ...kit,
      messages: {
        ...kit.messages,
        write: async (scope, write) => {
          const written = await kit.messages.write(scope, write);
          if (written.kind === "written") {
            await events.messageUpdated(kit, scope, messageId);
          }
          return written;
        },
      },
    };
  }

  /**
   * The owner token the accept stored the placeholder under. The turn writes
   * under the same one rather than deriving it again, so the kit's owner rule
   * compares a value with itself. The placeholder must still be the latest
   * message: only the latest message can be written to.
   */
  async function placeholderBind(
    found: AssistantTurnForJob,
    caller: VerifiedAssistantCaller,
  ): Promise<string> {
    const latest = (
      await createPostgresAssistantKitMessageLog(storeDeps, caller).page(
        found.turn.conversationId,
        { limit: 1 },
      )
    ).records[0];
    if (latest?.messageId !== found.placeholderMessageId) {
      throw new CoreInvariantError(
        "assistant turn placeholder is not the conversation's latest message",
      );
    }
    return latest.bind;
  }

  /**
   * Ends the placeholder's text if it is still `streaming` — a turn that paused
   * or replied with no text left it so — and returns the status stored.
   */
  async function endText(
    kit: AssistantKitFor,
    scope: PauseScope,
    messageId: string,
    status: Exclude<TextStatus, "streaming">,
  ): Promise<TextStatus> {
    const stored = lastTextStatus(
      (await kit.messages.read(scope)).messages.find(
        (candidate) => candidate.messageId === messageId,
      ),
    );
    if (stored !== undefined && stored !== "streaming") {
      return stored;
    }
    const written = await kit.messages.write(scope, {
      kind: "append",
      messageId,
      role: "assistant",
      parts: [{ kind: "text", text: "", status }],
    });
    if (written.kind !== "written") {
      throw new MessageWriteRefusedError(written.kind);
    }
    return status;
  }

  async function runQueued(
    found: AssistantTurnForJob,
    caller: VerifiedAssistantCaller,
  ): Promise<AssistantTurnJobOutcome> {
    const fields = fieldsOf(found, caller.requestId);
    const turns = createPostgresAssistantTurnStore(storeDeps, caller);

    let started: Awaited<ReturnType<typeof turns.start>>;
    try {
      started = await turns.start(found.turn, { timeoutMs });
    } catch (error) {
      // Core would not act as this person — most often a membership that ended
      // after the accept. Nothing has run and nothing is written; the turn stays
      // queued. Closing it is an open owner question (SHO-569).
      if (error instanceof CoreError && error.code !== "INTERNAL") {
        logger.warn(
          { ...fields, code: error.code },
          "assistant turn refused at start and left queued",
        );
        return { kind: "refused", code: error.code };
      }
      throw error;
    }
    if (started.outcome === "not_queued") {
      return { kind: "not_queued", status: started.status };
    }

    const events = eventsFor(
      {
        companyId: found.companyId,
        conversationId: found.turn.conversationId,
      },
      fields,
    );
    await events.publish({
      type: "turn.started",
      conversationId: found.turn.conversationId,
      kind: found.turn.kind,
      commandId: found.turn.commandId,
    });

    const { kit, history } = deps.runtime.forCaller(caller);
    const writer = publishing(kit, events, found.placeholderMessageId);
    const controller = new AbortController();
    const disarm = deadline(() => {
      controller.abort();
    }, timeoutMs);
    let reachedModel = false;
    let scope: PauseScope | undefined;
    let status: AssistantTurnEndStatus;
    try {
      const turnScope: PauseScope = {
        conversationId: found.turn.conversationId,
        bind: await placeholderBind(found, caller),
      };
      scope = turnScope;
      const messages = await history.load(turnScope);
      const tools = await deps.runtime.tools({
        userId: caller.userId,
        companySelector: caller.companySelector,
        conversationId: found.turn.conversationId,
        commandId: found.continuationRootCommandId,
        requestId: caller.requestId,
      });
      const prompt = deps.runtime.prompt();

      reachedModel = true;
      const turn = await runHostTurn({
        system: prompt.system,
        ...(prompt.providerOptions === undefined
          ? {}
          : { providerOptions: prompt.providerOptions }),
        kit: writer,
        conversationId: turnScope.conversationId,
        bind: turnScope.bind,
        messageId: found.placeholderMessageId,
        model: deps.runtime.model,
        tools,
        messages,
        abortSignal: controller.signal,
        abortedTextStatus: "interrupted",
        saveHistory: (steps) => history.save(turnScope, steps),
      });
      // The host saves history per finished step, but not for the step that
      // paused: that history is the pause's continuation.
      if (turn.kind === "paused") {
        await history.save(turnScope, turn.messages);
      }
      if (turn.interrupted) {
        logger.warn(
          {
            ...fields,
            cards_written: turn.parts.filter((part) => part.kind === "card")
              .length,
            history_kept: turn.messages.length > messages.length,
          },
          "assistant turn did not finish",
        );
      }
      if (turn.kind === "pause_rejected") {
        // A tool asked for a kind or payload the registry refused: a bug in the
        // tool, stored as a failure rather than hidden.
        logger.error({ ...fields }, "assistant tool asked for a refused pause");
        await endText(writer, turnScope, found.placeholderMessageId, "error");
        status = "failed";
      } else {
        status =
          TURN_STATUS_OF_TEXT[
            await endText(
              writer,
              turnScope,
              found.placeholderMessageId,
              "complete",
            )
          ];
      }
    } catch (error) {
      // A card or history that could not be stored, a refused write, or any
      // other fault once the turn started. What it stored stands; Продовжити
      // continues it under the original command.
      logger.error({ ...fields, err: error }, "assistant turn interrupted");
      status = "interrupted";
      if (scope !== undefined) {
        try {
          await endText(
            writer,
            scope,
            found.placeholderMessageId,
            "interrupted",
          );
        } catch (endError) {
          logger.warn(
            { ...fields, err: endError },
            "assistant turn text could not be ended",
          );
        }
      }
    } finally {
      disarm();
    }

    const finished = await turns.finish(found.turn, status);
    if (finished.outcome === "already_finished") {
      logger.warn(
        { ...fields, status: finished.status },
        "assistant turn had already been finished",
      );
      return { kind: "already_finished", status: finished.status };
    }
    if (!reachedModel) {
      await releaseStaffAssistantBudgetHold({
        logger,
        requestId: caller.requestId,
        companyId: found.companyId,
        hold: finished.releasedHold,
        budgetStore: deps.budgetStore,
      });
    }
    if (scope !== undefined) {
      await events.finished(kit, scope, found, status);
    }
    return { kind: "finished", status, reachedModel };
  }

  return async (job) => {
    const found = await forJob.read({ job, requestId: newRequestId() });
    if (found === null) {
      logger.warn(
        { conversation_id: job.conversationId, turn_kind: job.kind },
        "assistant job names no turn and was dropped",
      );
      return { kind: "no_turn" };
    }
    if (found.caller === null) {
      return { kind: "not_queued", status: found.status };
    }
    return runQueued(found, found.caller);
  };
}
