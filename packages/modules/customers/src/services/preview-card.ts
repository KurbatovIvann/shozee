import type { ActionPreviewEnv } from "@showzy/core";
import type { ActionPreview, ActionPreviewLine } from "@showzy/core/errors";
import { NotFoundError } from "@showzy/core/errors";
import {
  COMPANY_CUSTOMER_DEFAULT_STATUS,
  companyCustomers,
  counterparties,
  customerGroups,
} from "@showzy/db/schema/customers";
import { parseDbEnum } from "@showzy/module-kit/parse-db-enum";
import { changeLines } from "@showzy/module-kit/preview-changes";
import { previewCompanyScope } from "@showzy/module-kit/preview-scope";
import { getPriceList } from "@showzy/pricing/get-price-list";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";

import type { createCounterpartyInputSchema } from "../actions/create-counterparty.contract.js";
import type { createCustomerInputSchema } from "../actions/create-customer.contract.js";
import type { createGroupInputSchema } from "../actions/create-group.contract.js";
import { customerStatusSchema } from "../actions/customer-view.contract.js";
import type { updateCounterpartyInputSchema } from "../actions/update-counterparty.contract.js";
import type { updateCustomerInputSchema } from "../actions/update-customer.contract.js";
import type { updateGroupInputSchema } from "../actions/update-group.contract.js";
import { countActiveGroupMembers } from "./count-active-members.js";
import { duplicateContactNotes } from "./duplicate-contact.js";

type PreviewEnv = ActionPreviewEnv;
type Contract = { readonly name: string };
type CustomerStatus = z.output<typeof customerStatusSchema>;

type CreateCustomerFields = z.output<typeof createCustomerInputSchema>;
type UpdateCustomerFields = Omit<
  z.output<typeof updateCustomerInputSchema>,
  "id"
>;
type CustomerPreviewFields = CreateCustomerFields | UpdateCustomerFields;

type CreateGroupFields = z.output<typeof createGroupInputSchema>;
type UpdateGroupFields = Omit<z.output<typeof updateGroupInputSchema>, "id">;
type GroupPreviewFields = CreateGroupFields | UpdateGroupFields;

type CreateCounterpartyFields = z.output<typeof createCounterpartyInputSchema>;
type UpdateCounterpartyFields = Omit<
  z.output<typeof updateCounterpartyInputSchema>,
  "id"
>;
type CounterpartyPreviewFields =
  CreateCounterpartyFields | UpdateCounterpartyFields;

export const PREVIEW_ABSENT = "—";
export const PREVIEW_CLEARED = "очистити";
export const CUSTOMER_STATUS_LABEL = "Статус";
export const CUSTOMER_CONTACT_LABEL = "Контакт";
export const GROUP_MEMBERS_LABEL = "Активні клієнти";

export const DELETE_CUSTOMER_NOTE =
  "Замовлення залишаться і втратять зв’язок із клієнтом. Прив’язані контрагенти залишаться окремими юридичними особами. Персональні ціни буде видалено.";
export const DELETE_GROUP_NOTE =
  "Клієнти залишаться і втратять групу: вони перейдуть на наступний рівень цін.";
export const DELETE_COUNTERPARTY_NOTE =
  "Прив’язаний клієнт CRM залишиться. Цю дію не можна скасувати.";

const STATUS_LABELS = {
  active: "активний",
  archived: "архівований",
} as const satisfies Record<CustomerStatus, string>;

const CUSTOMER_LABELS = {
  name: "Ім’я",
  phone: "Телефон",
  email: "Email",
  userId: "Користувач",
  notes: "Нотатки",
  groupId: "Група",
  priceListId: "Прайс-лист",
} as const satisfies Record<
  keyof (CreateCustomerFields & UpdateCustomerFields),
  string
>;

const CUSTOMER_TEXT_FIELDS = ["phone", "email", "userId", "notes"] as const;

const GROUP_LABELS = {
  name: "Назва",
  description: "Опис",
  priceListId: "Прайс-лист",
} as const satisfies Record<
  keyof (CreateGroupFields & UpdateGroupFields),
  string
>;

const COUNTERPARTY_LABELS = {
  name: "Назва",
  edrpou: "ЄДРПОУ",
  legalAddress: "Юридична адреса",
  iban: "IBAN",
  bankName: "Банк",
  bankMfo: "МФО",
  phone: "Телефон",
  email: "Email",
  notes: "Нотатки",
  customerId: "Клієнт",
} as const satisfies Record<
  keyof (CreateCounterpartyFields & UpdateCounterpartyFields),
  string
>;

const COUNTERPARTY_TEXT_FIELDS = [
  "edrpou",
  "legalAddress",
  "iban",
  "bankName",
  "bankMfo",
  "phone",
  "email",
  "notes",
] as const;

function changeLine(
  label: string,
  stored: string | null,
  patched: string | null,
): ActionPreviewLine {
  const next = patched ?? (stored === null ? PREVIEW_ABSENT : PREVIEW_CLEARED);
  if (stored === null || stored === next) {
    return { label, value: next };
  }
  return { label, value: `${stored} → ${next}` };
}

function text(value: string | null | undefined): string | null {
  return value === undefined || value === "" ? null : value;
}

function statusLabel(status: string): string {
  return STATUS_LABELS[
    parseDbEnum(
      customerStatusSchema,
      status,
      `company_customers row has illegal status "${status}"`,
    )
  ];
}

async function idLabel(
  id: string | null | undefined,
  resolve: (id: string) => Promise<string>,
): Promise<string | null> {
  return id === null || id === undefined ? null : resolve(id);
}

async function groupLabel(
  env: PreviewEnv,
  companyId: string,
  groupId: string,
): Promise<string> {
  const row = (
    await env.tx
      .select({ name: customerGroups.name })
      .from(customerGroups)
      .where(
        and(
          eq(customerGroups.companyId, companyId),
          eq(customerGroups.id, groupId),
        ),
      )
      .limit(1)
  )[0];
  if (row === undefined) {
    throw new NotFoundError();
  }
  return row.name;
}

async function priceListLabel(
  env: PreviewEnv,
  priceListId: string,
): Promise<string> {
  const list = await env.call(getPriceList, { id: priceListId });
  return list.name;
}

async function customerLabel(
  env: PreviewEnv,
  companyId: string,
  customerId: string,
): Promise<string> {
  const row = (
    await env.tx
      .select({ name: companyCustomers.name })
      .from(companyCustomers)
      .where(
        and(
          eq(companyCustomers.companyId, companyId),
          eq(companyCustomers.id, customerId),
        ),
      )
      .limit(1)
  )[0];
  if (row === undefined) {
    throw new NotFoundError();
  }
  return row.name;
}

async function loadCustomer(env: PreviewEnv, companyId: string, id: string) {
  const row = (
    await env.tx
      .select({
        name: companyCustomers.name,
        phone: companyCustomers.phone,
        email: companyCustomers.email,
        userId: companyCustomers.userId,
        notes: companyCustomers.notes,
        status: companyCustomers.status,
        groupId: companyCustomers.groupId,
        priceListId: companyCustomers.priceListId,
      })
      .from(companyCustomers)
      .where(
        and(
          eq(companyCustomers.companyId, companyId),
          eq(companyCustomers.id, id),
        ),
      )
      .limit(1)
  )[0];
  if (row === undefined) {
    throw new NotFoundError();
  }
  return row;
}

async function loadGroup(env: PreviewEnv, companyId: string, id: string) {
  const row = (
    await env.tx
      .select({
        name: customerGroups.name,
        description: customerGroups.description,
        priceListId: customerGroups.priceListId,
      })
      .from(customerGroups)
      .where(
        and(eq(customerGroups.companyId, companyId), eq(customerGroups.id, id)),
      )
      .limit(1)
  )[0];
  if (row === undefined) {
    throw new NotFoundError();
  }
  return row;
}

async function loadCounterparty(
  env: PreviewEnv,
  companyId: string,
  id: string,
) {
  const row = (
    await env.tx
      .select({
        name: counterparties.name,
        edrpou: counterparties.edrpou,
        legalAddress: counterparties.legalAddress,
        iban: counterparties.iban,
        bankName: counterparties.bankName,
        bankMfo: counterparties.bankMfo,
        phone: counterparties.phone,
        email: counterparties.email,
        notes: counterparties.notes,
        customerId: counterparties.customerId,
      })
      .from(counterparties)
      .where(
        and(eq(counterparties.companyId, companyId), eq(counterparties.id, id)),
      )
      .limit(1)
  )[0];
  if (row === undefined) {
    throw new NotFoundError();
  }
  return row;
}

type StoredCustomer = Awaited<ReturnType<typeof loadCustomer>>;
type StoredGroup = Awaited<ReturnType<typeof loadGroup>>;
type StoredCounterparty = Awaited<ReturnType<typeof loadCounterparty>>;

async function customerLines(
  env: PreviewEnv,
  companyId: string,
  input: CustomerPreviewFields,
  stored: StoredCustomer | null,
): Promise<ActionPreviewLine[]> {
  const named = (field: keyof CustomerPreviewFields): boolean =>
    stored === null || input[field] !== undefined;
  const lines: ActionPreviewLine[] = named("name")
    ? [
        changeLine(
          CUSTOMER_LABELS.name,
          stored?.name ?? null,
          input.name ?? null,
        ),
      ]
    : [];
  for (const field of CUSTOMER_TEXT_FIELDS) {
    if (named(field)) {
      lines.push(
        changeLine(
          CUSTOMER_LABELS[field],
          stored?.[field] ?? null,
          text(input[field]),
        ),
      );
    }
  }
  if (named("groupId")) {
    lines.push(
      changeLine(
        CUSTOMER_LABELS.groupId,
        await idLabel(stored?.groupId, (id) => groupLabel(env, companyId, id)),
        await idLabel(input.groupId, (id) => groupLabel(env, companyId, id)),
      ),
    );
  }
  if (named("priceListId")) {
    lines.push(
      changeLine(
        CUSTOMER_LABELS.priceListId,
        await idLabel(stored?.priceListId, (id) => priceListLabel(env, id)),
        await idLabel(input.priceListId, (id) => priceListLabel(env, id)),
      ),
    );
  }
  return lines;
}

async function groupLines(
  env: PreviewEnv,
  input: GroupPreviewFields,
  stored: StoredGroup | null,
): Promise<ActionPreviewLine[]> {
  const lines: ActionPreviewLine[] =
    stored === null || input.name !== undefined
      ? [
          changeLine(
            GROUP_LABELS.name,
            stored?.name ?? null,
            input.name ?? null,
          ),
        ]
      : [];
  if (stored === null || input.description !== undefined) {
    lines.push(
      changeLine(
        GROUP_LABELS.description,
        stored?.description ?? null,
        text(input.description),
      ),
    );
  }
  if (stored === null || input.priceListId !== undefined) {
    lines.push(
      changeLine(
        GROUP_LABELS.priceListId,
        await idLabel(stored?.priceListId, (id) => priceListLabel(env, id)),
        await idLabel(input.priceListId, (id) => priceListLabel(env, id)),
      ),
    );
  }
  return lines;
}

async function counterpartyLines(
  env: PreviewEnv,
  companyId: string,
  input: CounterpartyPreviewFields,
  stored: StoredCounterparty | null,
): Promise<ActionPreviewLine[]> {
  const named = (field: keyof CounterpartyPreviewFields): boolean =>
    stored === null || input[field] !== undefined;
  const lines: ActionPreviewLine[] = named("name")
    ? [
        changeLine(
          COUNTERPARTY_LABELS.name,
          stored?.name ?? null,
          input.name ?? null,
        ),
      ]
    : [];
  for (const field of COUNTERPARTY_TEXT_FIELDS) {
    if (named(field)) {
      lines.push(
        changeLine(
          COUNTERPARTY_LABELS[field],
          stored?.[field] ?? null,
          text(input[field]),
        ),
      );
    }
  }
  if (named("customerId")) {
    lines.push(
      changeLine(
        COUNTERPARTY_LABELS.customerId,
        await idLabel(stored?.customerId, (id) =>
          customerLabel(env, companyId, id),
        ),
        await idLabel(input.customerId, (id) =>
          customerLabel(env, companyId, id),
        ),
      ),
    );
  }
  return lines;
}

export function createCustomerPreview(
  contract: Contract,
): (input: CreateCustomerFields, env: PreviewEnv) => Promise<ActionPreview> {
  return async (input, env) => {
    const companyId = previewCompanyScope(env.companyId, contract);
    const notes = await duplicateContactNotes(env.tx, companyId, input);
    return {
      title: `Новий клієнт: ${input.name}`,
      lines: [
        ...(await customerLines(env, companyId, input, null)),
        {
          label: CUSTOMER_STATUS_LABEL,
          value: statusLabel(COMPANY_CUSTOMER_DEFAULT_STATUS),
        },
      ],
      ...(notes.length > 0 ? { notes } : {}),
    };
  };
}

export function updateCustomerPreview(
  contract: Contract,
): (
  input: UpdateCustomerFields & { readonly id: string },
  env: PreviewEnv,
) => Promise<ActionPreview> {
  return async (input, env) => {
    const companyId = previewCompanyScope(env.companyId, contract);
    const stored = await loadCustomer(env, companyId, input.id);
    return {
      title: `Змінити клієнта: ${stored.name}`,
      lines: changeLines(await customerLines(env, companyId, input, stored)),
    };
  };
}

export function customerStatusPreview(
  contract: Contract,
  subject: string,
  status: CustomerStatus,
): (input: { readonly id: string }, env: PreviewEnv) => Promise<ActionPreview> {
  return async (input, env) => {
    const companyId = previewCompanyScope(env.companyId, contract);
    const stored = await loadCustomer(env, companyId, input.id);
    return {
      title: `${subject}: ${stored.name}`,
      lines: [
        changeLine(
          CUSTOMER_STATUS_LABEL,
          statusLabel(stored.status),
          STATUS_LABELS[status],
        ),
      ],
    };
  };
}

export function deleteCustomerPreview(
  contract: Contract,
): (input: { readonly id: string }, env: PreviewEnv) => Promise<ActionPreview> {
  return async (input, env) => {
    const companyId = previewCompanyScope(env.companyId, contract);
    const stored = await loadCustomer(env, companyId, input.id);
    const contact =
      text(stored.phone) ?? text(stored.email) ?? text(stored.userId);
    return {
      title: `Видалити клієнта: ${stored.name}`,
      lines: [
        { label: CUSTOMER_CONTACT_LABEL, value: contact ?? PREVIEW_ABSENT },
        { label: CUSTOMER_STATUS_LABEL, value: statusLabel(stored.status) },
      ],
      notes: [DELETE_CUSTOMER_NOTE],
    };
  };
}

export function createGroupPreview(
  contract: Contract,
): (input: CreateGroupFields, env: PreviewEnv) => Promise<ActionPreview> {
  return async (input, env) => {
    previewCompanyScope(env.companyId, contract);
    return {
      title: `Нова група клієнтів: ${input.name}`,
      lines: await groupLines(env, input, null),
    };
  };
}

export function updateGroupPreview(
  contract: Contract,
): (
  input: UpdateGroupFields & { readonly id: string },
  env: PreviewEnv,
) => Promise<ActionPreview> {
  return async (input, env) => {
    const companyId = previewCompanyScope(env.companyId, contract);
    const stored = await loadGroup(env, companyId, input.id);
    return {
      title: `Змінити групу клієнтів: ${stored.name}`,
      lines: changeLines(await groupLines(env, input, stored)),
    };
  };
}

export function deleteGroupPreview(
  contract: Contract,
): (input: { readonly id: string }, env: PreviewEnv) => Promise<ActionPreview> {
  return async (input, env) => {
    const companyId = previewCompanyScope(env.companyId, contract);
    const stored = await loadGroup(env, companyId, input.id);
    const members = await countActiveGroupMembers(env.tx, companyId, input.id);
    return {
      title: `Видалити групу клієнтів: ${stored.name}`,
      lines: [{ label: GROUP_MEMBERS_LABEL, value: String(members) }],
      notes: [DELETE_GROUP_NOTE],
    };
  };
}

export function createCounterpartyPreview(
  contract: Contract,
): (
  input: CreateCounterpartyFields,
  env: PreviewEnv,
) => Promise<ActionPreview> {
  return async (input, env) => {
    const companyId = previewCompanyScope(env.companyId, contract);
    return {
      title: `Новий контрагент: ${input.name}`,
      lines: await counterpartyLines(env, companyId, input, null),
    };
  };
}

export function updateCounterpartyPreview(
  contract: Contract,
): (
  input: UpdateCounterpartyFields & { readonly id: string },
  env: PreviewEnv,
) => Promise<ActionPreview> {
  return async (input, env) => {
    const companyId = previewCompanyScope(env.companyId, contract);
    const stored = await loadCounterparty(env, companyId, input.id);
    return {
      title: `Змінити контрагента: ${stored.name}`,
      lines: changeLines(
        await counterpartyLines(env, companyId, input, stored),
      ),
    };
  };
}

export function deleteCounterpartyPreview(
  contract: Contract,
): (input: { readonly id: string }, env: PreviewEnv) => Promise<ActionPreview> {
  return async (input, env) => {
    const companyId = previewCompanyScope(env.companyId, contract);
    const stored = await loadCounterparty(env, companyId, input.id);
    return {
      title: `Видалити контрагента: ${stored.name}`,
      lines: [
        {
          label: COUNTERPARTY_LABELS.edrpou,
          value: text(stored.edrpou) ?? PREVIEW_ABSENT,
        },
      ],
      notes: [DELETE_COUNTERPARTY_NOTE],
    };
  };
}
