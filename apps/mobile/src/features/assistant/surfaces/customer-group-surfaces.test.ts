import {
  CUSTOMER_GROUP_ENTITY_GET_TOOL,
  CUSTOMER_GROUPS_LIST_TOOL,
  parseCustomerGroupEntitySurfaces,
  parseCustomerGroupsSurface,
  type AssistantCustomerGroupEntityData,
  type AssistantCustomerGroupsData,
} from "@showzy/validation/assistant-surfaces";
import { describe, expect, it } from "vitest";

import { assistantCopy } from "../../../i18n/assistant";
import { customersCopy } from "../../../i18n/customers";
import { groupEditorHref } from "../../customers/shared/customer-hrefs";
import { memberCountLabel } from "../../customers/shared/member-count";
import { localizeAssistantCardPayload } from "./compose";
import { localizeCustomerGroupEntityCard } from "./customer-group-entity";
import { localizeCustomerGroupsCard } from "./customer-groups";

const GROUP_A = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f70819203";
const GROUP_B = "8b9c0d1e-2f30-4b4c-9d5e-6f7081920314";

function groupEntity(
  payload: Record<string, unknown>,
): AssistantCustomerGroupEntityData {
  const parsed = parseCustomerGroupEntitySurfaces([
    { toolName: CUSTOMER_GROUP_ENTITY_GET_TOOL, output: payload },
  ]);
  const entity = parsed[0];
  if (entity === undefined) {
    throw new Error("group did not compose");
  }
  return entity;
}

function groupsList(
  items: readonly Record<string, unknown>[],
  nextCursor: string | null = null,
): AssistantCustomerGroupsData {
  const surface = parseCustomerGroupsSurface([
    { toolName: CUSTOMER_GROUPS_LIST_TOOL, output: { items, nextCursor } },
  ]);
  if (surface === null) {
    throw new Error("groups list did not compose");
  }
  return surface;
}

describe("customer-group-entity card (SHO-873)", () => {
  it("localizes the name, the description and the client count", () => {
    const card = localizeCustomerGroupEntityCard(
      groupEntity({
        id: GROUP_A,
        name: "Оптовики",
        description: "Гуртові замовлення",
        memberCount: 4,
      }),
      "uk",
    );
    expect(card.kind).toBe("customer-group-entity");
    expect(card.title).toBe("Оптовики");
    expect(card.href).toBe(groupEditorHref(GROUP_A));
    expect(card.detailRows).toEqual(["Гуртові замовлення"]);
    expect(card.statusLabel).toBe(
      memberCountLabel(4, "uk", customersCopy("uk").members),
    );
    expect(card.handoffLabel).toBe(assistantCopy("uk").cards.openCustomerGroup);
    expect(card.destination).toEqual({
      kind: "screen",
      href: groupEditorHref(GROUP_A),
    });
  });

  it("falls back to the id and shows no count when the payload carries neither", () => {
    const card = localizeCustomerGroupEntityCard(
      groupEntity({ id: GROUP_A, description: null }),
      "en",
    );
    expect(card.title).toBe(GROUP_A);
    expect(card.detailRows).toEqual([]);
    expect(card.statusLabel).toBeNull();
    expect(card.handoffLabel).toBe(assistantCopy("en").cards.openCustomerGroup);
  });
});

describe("customer-groups card (SHO-873)", () => {
  it("localizes rows, client counts and the group editor hrefs", () => {
    const card = localizeCustomerGroupsCard(
      groupsList([
        { id: GROUP_A, name: "Оптовики", memberCount: 4 },
        { id: GROUP_B, name: "Кафе", memberCount: 0 },
      ]),
      "uk",
    );
    const members = customersCopy("uk").members;
    expect(card.rows).toEqual([
      {
        groupId: GROUP_A,
        href: groupEditorHref(GROUP_A),
        name: "Оптовики",
        membersLabel: memberCountLabel(4, "uk", members),
      },
      {
        groupId: GROUP_B,
        href: groupEditorHref(GROUP_B),
        name: "Кафе",
        membersLabel: memberCountLabel(0, "uk", members),
      },
    ]);
    expect(card.emptyTitle).toBeNull();
    expect(card.ctaHref).toBeNull();
    expect(card.collection.rows[0]?.badge).toBe(
      memberCountLabel(4, "uk", members),
    );
  });

  it("hands off to the customers screen once, not again as a second cta", () => {
    const card = localizeCustomerGroupsCard(
      groupsList([{ id: GROUP_A, name: "Wholesale", memberCount: 4 }], "next"),
      "en",
    );
    expect(card.handoffLabel).toBe("Open customers");
    expect(card.destination).toEqual({ kind: "screen", href: "/customers" });
    expect(card.ctaHref).toBeNull();
    expect(card.ctaLabel).toBeNull();
  });

  it("names the empty list in the reader's language", () => {
    expect(localizeCustomerGroupsCard(groupsList([]), "en")).toMatchObject({
      emptyTitle: "No customer groups",
      rows: [],
    });
    expect(localizeCustomerGroupsCard(groupsList([]), "uk")).toMatchObject({
      emptyTitle: "Немає груп клієнтів",
    });
  });
});

describe("a stored customer-group card payload localizes through compose (SHO-873)", () => {
  it("rebuilds both cards from what the server stored", () => {
    const entity = groupEntity({
      id: GROUP_A,
      name: "Оптовики",
      description: null,
      memberCount: 4,
    });
    expect(
      localizeAssistantCardPayload("customer-group-entity", entity, "uk"),
    ).toEqual(localizeCustomerGroupEntityCard(entity, "uk"));
    const list = groupsList([
      { id: GROUP_A, name: "Оптовики", memberCount: 4 },
    ]);
    expect(localizeAssistantCardPayload("customer-groups", list, "uk")).toEqual(
      localizeCustomerGroupsCard(list, "uk"),
    );
  });
});
