/**
 * Authenticated confirmation resume (SHO-516 / ADR-0035). Cookie +
 * `x-company-id` are headers — never action input. Body is
 * `{ conversationId, challengeId }` only. No GET peek.
 *
 * Successful interaction envelopes (`status` string) are decoded
 * separately from HTTP/Core error envelopes (`status` number).
 */
import { fetch as expoFetch } from "expo/fetch";
import { isWireError } from "@showzy/contract";
import { z } from "zod";

import {
  type ConfirmationConfirmRecoverability,
  type ConfirmationConfirmResult,
} from "../shared/confirmation-presenter";
import { staffAssistantChatHeaders } from "./assistant-chat-headers";

export const ASSISTANT_CONFIRM_PATH = "/assistant/confirm";

/**
 * Per-status wire shape for a successful HTTP 200 interaction. Duplicates
 * the server `@showzy/ai` union — mobile must not import that package.
 */
const confirmInteractionResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    text: z.string().min(1),
    actionName: z.string().min(1),
    toolCallId: z.string().min(1),
    output: z.unknown().optional(),
  }),
  z.object({
    status: z.literal("expired"),
  }),
  z.object({
    status: z.literal("error"),
    code: z.string().min(1),
    message: z.string().min(1),
  }),
]);

const coreWireErrorBodySchema = z.object({
  code: z.string().min(1),
  status: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});

export type {
  ConfirmationConfirmRecoverability,
  ConfirmationConfirmResult,
} from "../shared/confirmation-presenter";

function assistantOrigin(apiOrigin: string): string {
  return apiOrigin.replace(/\/+$/, "");
}

export function assistantConfirmUrl(apiOrigin: string): string {
  return `${assistantOrigin(apiOrigin)}${ASSISTANT_CONFIRM_PATH}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function retryAfterSecFrom(
  response: Response,
  data: unknown,
): number | undefined {
  if (isRecord(data) && typeof data.retryAfterSec === "number") {
    const fromData = data.retryAfterSec;
    if (Number.isFinite(fromData) && fromData >= 0) {
      return fromData;
    }
  }
  const header = response.headers.get("Retry-After");
  if (header === null || header === "") {
    return undefined;
  }
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }
  return seconds;
}

function httpFailureRecoverability(
  httpStatus: number,
  code: string | undefined,
): ConfirmationConfirmRecoverability {
  if (
    code === "RETRY_IN_PROGRESS" ||
    code === "RATE_LIMITED" ||
    code === "TIMEOUT"
  ) {
    return "retryable";
  }
  if (
    httpStatus === 408 ||
    httpStatus === 429 ||
    httpStatus === 502 ||
    httpStatus === 503 ||
    httpStatus === 504 ||
    (httpStatus >= 500 && httpStatus <= 599)
  ) {
    return "retryable";
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return "terminal";
  }
  return "ambiguous";
}

function withRecoverability(
  result: Omit<ConfirmationConfirmResult, "recoverability"> & {
    readonly recoverability?: ConfirmationConfirmRecoverability;
  },
): ConfirmationConfirmResult {
  if (result.status === "completed" || result.status === "expired") {
    return { ...result, recoverability: "terminal" };
  }
  if (result.httpStatus === 200) {
    return { ...result, recoverability: "terminal" };
  }
  const recoverability =
    result.recoverability ??
    (result.httpStatus === undefined
      ? "ambiguous"
      : httpFailureRecoverability(result.httpStatus, result.code));
  return { ...result, recoverability };
}

function confirmResultFromWireError(
  response: Response,
  raw: unknown,
): ConfirmationConfirmResult {
  const retryAfterSec = retryAfterSecFrom(
    response,
    isRecord(raw) ? raw.data : undefined,
  );
  if (isWireError(raw)) {
    return withRecoverability({
      status: "error",
      code: raw.code,
      message: raw.message,
      httpStatus: response.status,
      ...(retryAfterSec === undefined ? {} : { retryAfterSec }),
    });
  }
  const parsed = coreWireErrorBodySchema.safeParse(raw);
  if (parsed.success) {
    return withRecoverability({
      status: "error",
      code: parsed.data.code,
      message: parsed.data.message,
      httpStatus: response.status,
      ...(retryAfterSec === undefined ? {} : { retryAfterSec }),
    });
  }
  const code =
    isRecord(raw) && typeof raw.code === "string" ? raw.code : undefined;
  return withRecoverability({
    status: "error",
    ...(code === undefined ? {} : { code }),
    httpStatus: response.status,
    ...(retryAfterSec === undefined ? {} : { retryAfterSec }),
  });
}

async function readJsonBody(
  response: Response,
): Promise<
  { readonly ok: true; readonly value: unknown } | { readonly ok: false }
> {
  try {
    return { ok: true, value: await response.json() };
  } catch {
    return { ok: false };
  }
}

function malformedConfirmResult(
  httpStatus: number | undefined,
  recoverability: ConfirmationConfirmRecoverability,
): ConfirmationConfirmResult {
  return {
    status: "error",
    ...(httpStatus === undefined ? {} : { httpStatus }),
    recoverability,
  };
}

type ParsedConfirmInteraction = z.infer<typeof confirmInteractionResultSchema>;

function confirmResultFromInteraction(
  interaction: ParsedConfirmInteraction,
  httpStatus: number,
): Omit<ConfirmationConfirmResult, "recoverability"> {
  switch (interaction.status) {
    case "completed":
      return {
        status: "completed",
        text: interaction.text,
        actionName: interaction.actionName,
        toolCallId: interaction.toolCallId,
        ...(interaction.output === undefined
          ? {}
          : { output: interaction.output }),
        httpStatus,
      };
    case "expired":
      return { status: "expired", httpStatus };
    case "error":
      return {
        status: "error",
        code: interaction.code,
        message: interaction.message,
        httpStatus,
      };
  }
}

export async function postAssistantConfirm(args: {
  readonly apiUrl: string;
  readonly getCookie: () => string | null;
  readonly getCompanyId: () => string | null;
  readonly conversationId: string;
  readonly challengeId: string;
}): Promise<ConfirmationConfirmResult> {
  let response: Response;
  try {
    response = await expoFetch(assistantConfirmUrl(args.apiUrl), {
      method: "POST",
      credentials: "omit",
      headers: {
        "content-type": "application/json",
        ...staffAssistantChatHeaders({
          cookie: args.getCookie(),
          companyId: args.getCompanyId(),
        }),
      },
      body: JSON.stringify({
        conversationId: args.conversationId,
        challengeId: args.challengeId,
      }),
    });
  } catch {
    return { status: "error", recoverability: "retryable" };
  }

  const body = await readJsonBody(response);
  if (!response.ok) {
    if (!body.ok) {
      return malformedConfirmResult(
        response.status,
        httpFailureRecoverability(response.status, undefined),
      );
    }
    return confirmResultFromWireError(response, body.value);
  }
  if (!body.ok) {
    return malformedConfirmResult(response.status, "ambiguous");
  }
  const parsed = confirmInteractionResultSchema.safeParse(body.value);
  if (!parsed.success) {
    return malformedConfirmResult(response.status, "ambiguous");
  }
  return withRecoverability(
    confirmResultFromInteraction(parsed.data, response.status),
  );
}
