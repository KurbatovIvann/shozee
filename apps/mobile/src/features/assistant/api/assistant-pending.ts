/**
 * Authenticated staff assistant HTTP (SHO-522 / SHO-524). Cookie +
 * `x-company-id` are headers — never action input. Bodies never include
 * canonical input, challenge hashes, or pending secrets from the model.
 * Chat is JSON `{ conversationId, text, locale? }` on `POST /assistant/chat`.
 */
import { fetch as expoFetch } from "expo/fetch";
import { isWireError } from "@showzy/contract";
import { z } from "zod";

import {
  ASSISTANT_CONFIRM_PATH,
  ASSISTANT_PENDING_ABANDON_PATH,
  ASSISTANT_PENDING_PATH,
  assistantHostInteractionResultSchema,
  assistantPendingPeekResultSchema,
  type AssistantHostInteractionResult,
  type AssistantPendingPeekResult,
} from "../shared/resume-envelope";
import {
  assistantChatUrl,
  staffAssistantChatBody,
} from "./assistant-chat-body";
import { staffAssistantChatHeaders } from "./assistant-chat-headers";

const coreWireErrorBodySchema = z.object({
  code: z.string().min(1),
  status: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});

function assistantOrigin(apiOrigin: string): string {
  return apiOrigin.replace(/\/+$/, "");
}

export function assistantConfirmUrl(apiOrigin: string): string {
  return `${assistantOrigin(apiOrigin)}${ASSISTANT_CONFIRM_PATH}`;
}

export function assistantPendingUrl(
  apiOrigin: string,
  conversationId: string,
): string {
  return `${assistantOrigin(apiOrigin)}${ASSISTANT_PENDING_PATH}?conversationId=${encodeURIComponent(conversationId)}`;
}

export function assistantPendingAbandonUrl(apiOrigin: string): string {
  return `${assistantOrigin(apiOrigin)}${ASSISTANT_PENDING_ABANDON_PATH}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function malformedError(
  httpStatus: number | undefined,
): AssistantHostInteractionResult {
  return {
    status: "error",
    code: "MALFORMED",
    message:
      httpStatus === undefined
        ? "Pending request failed."
        : `Pending request failed (${String(httpStatus)}).`,
  };
}

function resultFromWireError(
  response: Response,
  raw: unknown,
): AssistantHostInteractionResult {
  if (isWireError(raw)) {
    return {
      status: "error",
      code: raw.code,
      message: raw.message,
    };
  }
  const parsed = coreWireErrorBodySchema.safeParse(raw);
  if (parsed.success) {
    return {
      status: "error",
      code: parsed.data.code,
      message: parsed.data.message,
    };
  }
  const code =
    isRecord(raw) && typeof raw.code === "string" ? raw.code : undefined;
  return {
    status: "error",
    code: code ?? "HTTP_ERROR",
    message: `Pending request failed (${String(response.status)}).`,
  };
}

function interactionFromBody(
  body: unknown,
  httpStatus: number,
): AssistantHostInteractionResult {
  const parsed = assistantHostInteractionResultSchema.safeParse(body);
  if (parsed.success) {
    return parsed.data;
  }
  return malformedError(httpStatus);
}

export async function getAssistantPending(args: {
  readonly apiUrl: string;
  readonly getCookie: () => string | null;
  readonly getCompanyId: () => string | null;
  readonly conversationId: string;
}): Promise<
  | {
      readonly kind: "ok";
      readonly pending: AssistantPendingPeekResult["pending"];
    }
  | { readonly kind: "unavailable" }
> {
  let response: Response;
  try {
    response = await expoFetch(
      assistantPendingUrl(args.apiUrl, args.conversationId),
      {
        method: "GET",
        credentials: "omit",
        headers: staffAssistantChatHeaders({
          cookie: args.getCookie(),
          companyId: args.getCompanyId(),
        }),
      },
    );
  } catch {
    return { kind: "unavailable" };
  }
  const body = await readJsonBody(response);
  if (!response.ok || !body.ok) {
    return { kind: "unavailable" };
  }
  const parsed = assistantPendingPeekResultSchema.safeParse(body.value);
  if (!parsed.success) {
    return { kind: "unavailable" };
  }
  return { kind: "ok", pending: parsed.data.pending };
}

export async function postAssistantChat(args: {
  readonly apiUrl: string;
  readonly getCookie: () => string | null;
  readonly getCompanyId: () => string | null;
  readonly conversationId: string;
  readonly text: string;
  readonly locale?: "uk" | "en";
}): Promise<AssistantHostInteractionResult> {
  let response: Response;
  try {
    response = await expoFetch(assistantChatUrl(args.apiUrl), {
      method: "POST",
      credentials: "omit",
      headers: {
        "content-type": "application/json",
        ...staffAssistantChatHeaders({
          cookie: args.getCookie(),
          companyId: args.getCompanyId(),
        }),
      },
      body: JSON.stringify(
        staffAssistantChatBody({
          conversationId: args.conversationId,
          text: args.text,
          ...(args.locale === undefined ? {} : { locale: args.locale }),
        }),
      ),
    });
  } catch {
    return {
      status: "error",
      code: "NETWORK",
      message: "Chat request failed.",
    };
  }
  const body = await readJsonBody(response);
  if (!response.ok) {
    if (!body.ok) {
      return malformedError(response.status);
    }
    return resultFromWireError(response, body.value);
  }
  if (!body.ok) {
    return malformedError(response.status);
  }
  return interactionFromBody(body.value, response.status);
}

export async function postAssistantConfirm(args: {
  readonly apiUrl: string;
  readonly getCookie: () => string | null;
  readonly getCompanyId: () => string | null;
  readonly conversationId: string;
  readonly challengeId: string;
}): Promise<AssistantHostInteractionResult> {
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
    return {
      status: "error",
      code: "NETWORK",
      message: "Confirm request failed.",
    };
  }
  const body = await readJsonBody(response);
  if (!response.ok) {
    if (!body.ok) {
      return malformedError(response.status);
    }
    return resultFromWireError(response, body.value);
  }
  if (!body.ok) {
    return malformedError(response.status);
  }
  return interactionFromBody(body.value, response.status);
}

export async function postAssistantPendingAbandon(args: {
  readonly apiUrl: string;
  readonly getCookie: () => string | null;
  readonly getCompanyId: () => string | null;
  readonly conversationId: string;
  readonly pendingId: string;
  readonly expectedVersion: number;
}): Promise<AssistantHostInteractionResult> {
  let response: Response;
  try {
    response = await expoFetch(assistantPendingAbandonUrl(args.apiUrl), {
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
        pendingId: args.pendingId,
        expectedVersion: args.expectedVersion,
      }),
    });
  } catch {
    return {
      status: "error",
      code: "NETWORK",
      message: "Abandon request failed.",
    };
  }
  const body = await readJsonBody(response);
  if (!response.ok) {
    if (!body.ok) {
      return malformedError(response.status);
    }
    return resultFromWireError(response, body.value);
  }
  if (!body.ok) {
    return malformedError(response.status);
  }
  return interactionFromBody(body.value, response.status);
}
