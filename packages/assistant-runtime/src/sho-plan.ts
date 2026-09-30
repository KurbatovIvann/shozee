import { kyivNamedPeriodRange } from "@showzy/ai";

import type { ChoicePickerTarget } from "./assistant-interactions.js";

export interface ShoRef {
  readonly text: string;
  readonly status: string;
  readonly id?: string | null;
  readonly name?: string;
  readonly candidates?: readonly {
    readonly id: string | null;
    readonly name: string;
    readonly label?: string;
  }[];
}

export interface ShoOrderItem {
  readonly product: ShoRef;
  readonly variant: { readonly status: string; readonly id?: string };
  readonly quantity: { readonly value: number | null };
}

export interface ShoCommand {
  readonly action: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly needs: readonly {
    readonly path: string;
    readonly reason: string;
    readonly blocking: boolean;
  }[];
  readonly confidence: {
    readonly action: number;
    readonly margin: number;
    readonly spans: number;
  };
}

export interface ShoResult {
  readonly tooMany: boolean;
  readonly commands: readonly ShoCommand[];
}

export interface ShoEngine {
  parse(input: {
    readonly text: string;
    readonly now: Date;
  }): Promise<ShoResult>;
}

export const SHO_ORDERS_LIST_TOOL = "orders_list_page";
export const SHO_ORDERS_CREATE_TOOL = "orders_create";

export const SHO_WHITELIST: Readonly<Record<string, string>> = {
  "orders.list": SHO_ORDERS_LIST_TOOL,
  "orders.create": SHO_ORDERS_CREATE_TOOL,
};

export const SHO_CONFIDENCE_FLOOR = {
  action: 0.9,
  margin: 0.4,
  spans: 0.6,
} as const;

export const SHO_CHOICE_OPTIONS_MAX = 5;

export type ShoFallbackReason =
  | "no_command"
  | "many_commands"
  | "not_whitelisted"
  | "low_confidence"
  | "unsupported_param"
  | "unresolved_reference"
  | "blocking_need"
  | "engine_failed";

interface ShoCall {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
}

export interface ShoReadPlan extends ShoCall {
  readonly kind: "read";
}

export interface ShoWritePlan extends ShoCall {
  readonly kind: "write";
}

export interface ShoChoicePlan extends ShoCall {
  readonly kind: "choice";
  readonly target: ChoicePickerTarget;
  readonly subject: string;
  readonly options: readonly {
    readonly optionId: string;
    readonly label: string;
  }[];
  readonly optionsTruncated: boolean;
}

export interface ShoFallbackPlan {
  readonly kind: "fallback";
  readonly reason: ShoFallbackReason;
}

export type ShoPlan =
  ShoReadPlan | ShoWritePlan | ShoChoicePlan | ShoFallbackPlan;

function fallback(reason: ShoFallbackReason): ShoFallbackPlan {
  return { kind: "fallback", reason };
}

function isRef(param: unknown): param is ShoRef {
  return (
    typeof param === "object" &&
    param !== null &&
    !Array.isArray(param) &&
    "status" in param &&
    !("attrs" in param)
  );
}

function isOrderItems(param: unknown): param is readonly ShoOrderItem[] {
  return (
    Array.isArray(param) &&
    param.every(
      (item) => typeof item === "object" && item !== null && "product" in item,
    )
  );
}

function enumValue(param: unknown): string | null {
  return typeof param === "object" &&
    param !== null &&
    !Array.isArray(param) &&
    "value" in param &&
    typeof param.value === "string"
    ? param.value
    : null;
}

function confident(command: ShoCommand): boolean {
  return (
    command.confidence.action >= SHO_CONFIDENCE_FLOOR.action &&
    command.confidence.margin >= SHO_CONFIDENCE_FLOOR.margin &&
    command.confidence.spans >= SHO_CONFIDENCE_FLOOR.spans
  );
}

function unexpected(command: ShoCommand, allowed: readonly string[]): boolean {
  return Object.keys(command.params).some((name) => !allowed.includes(name));
}

function customerOf(
  param: unknown,
  call: ShoCall,
):
  | { readonly kind: "id"; readonly id: string }
  | { readonly kind: "choice"; readonly plan: ShoChoicePlan }
  | ShoFallbackPlan {
  if (!isRef(param)) {
    return fallback("unresolved_reference");
  }
  if (param.status === "resolved" && typeof param.id === "string") {
    return { kind: "id", id: param.id };
  }
  if (param.status !== "ambiguous") {
    return fallback("unresolved_reference");
  }
  const named = (param.candidates ?? []).filter(
    (candidate) => typeof candidate.id === "string" && candidate.id.length > 0,
  );
  if (named.length < 2) {
    return fallback("unresolved_reference");
  }
  const shown = named.slice(0, SHO_CHOICE_OPTIONS_MAX);
  return {
    kind: "choice",
    plan: {
      kind: "choice",
      ...call,
      target: { kind: "customer", query: param.text },
      subject: param.text,
      options: shown.map((candidate) => ({
        optionId: String(candidate.id),
        label: candidate.label ?? candidate.name,
      })),
      optionsTruncated: shown.length < named.length,
    },
  };
}

function planOrdersList(command: ShoCommand, now: Date): ShoPlan {
  if (unexpected(command, ["customer", "period"])) {
    return fallback("unsupported_param");
  }
  const input: Record<string, unknown> = {};

  if (command.params["period"] !== undefined) {
    const period = enumValue(command.params["period"]);
    const range = period === null ? null : kyivNamedPeriodRange(period, now);
    if (range === null) {
      return fallback("unsupported_param");
    }
    input["createdFrom"] = range.createdFrom;
    input["createdTo"] = range.createdTo;
  }

  const call = { toolName: SHO_ORDERS_LIST_TOOL, input };
  if (command.params["customer"] === undefined) {
    return { kind: "read", ...call };
  }
  const customer = customerOf(command.params["customer"], call);
  if (customer.kind === "fallback") {
    return customer;
  }
  if (customer.kind === "choice") {
    return customer.plan;
  }
  return {
    kind: "read",
    toolName: SHO_ORDERS_LIST_TOOL,
    input: { ...input, customerIds: [customer.id] },
  };
}

function planOrdersCreate(command: ShoCommand): ShoPlan {
  if (unexpected(command, ["customer", "items"])) {
    return fallback("unsupported_param");
  }
  const said = command.params["items"];
  if (!isOrderItems(said) || said.length === 0) {
    return fallback("unsupported_param");
  }
  const items: Record<string, unknown>[] = [];
  for (const item of said) {
    const variant = item.variant;
    const unusable =
      item.product.status !== "resolved" ||
      typeof item.product.id !== "string" ||
      (variant.status === "resolved" && variant.id === undefined) ||
      !["resolved", "none", "unspecified"].includes(variant.status);
    if (unusable) {
      return fallback("unresolved_reference");
    }
    if (item.quantity.value === null || item.quantity.value <= 0) {
      return fallback("unsupported_param");
    }
    items.push({
      productId: item.product.id,
      ...(variant.id === undefined ? {} : { variantId: variant.id }),
      quantityDecimal: item.quantity.value.toFixed(3),
    });
  }

  const call = { toolName: SHO_ORDERS_CREATE_TOOL, input: { items } };
  const customer = customerOf(command.params["customer"], call);
  if (customer.kind === "fallback") {
    return customer;
  }
  if (customer.kind === "choice") {
    return customer.plan;
  }
  return {
    kind: "write",
    toolName: SHO_ORDERS_CREATE_TOOL,
    input: { customerId: customer.id, items },
  };
}

export function planShoTurn(result: ShoResult, now: Date): ShoPlan {
  if (result.tooMany || result.commands.length > 1) {
    return fallback("many_commands");
  }
  const command = result.commands[0];
  if (command === undefined) {
    return fallback("no_command");
  }
  const toolName = SHO_WHITELIST[command.action];
  if (toolName === undefined) {
    return fallback("not_whitelisted");
  }
  if (!confident(command)) {
    return fallback("low_confidence");
  }
  const onlyAmbiguousCustomer = command.needs.every(
    (need) =>
      !need.blocking ||
      (need.path === "customer" && need.reason === "ambiguous"),
  );
  if (!onlyAmbiguousCustomer) {
    return fallback("blocking_need");
  }
  return toolName === SHO_ORDERS_LIST_TOOL
    ? planOrdersList(command, now)
    : planOrdersCreate(command);
}
