import { randomUUID } from "node:crypto";

import {
  createConfirmationHook,
  createInMemoryConfirmationStore,
  type ActionPipelineDeps,
  type ImplementedAction,
} from "@showzy/core";
import {
  ConfirmationRequiredError,
  NotFoundError,
  type ActionPreview,
} from "@showzy/core/errors";
import {
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { companyCustomerInvites } from "@showzy/db/schema/invites";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";

import { createInvite } from "./create.js";
import { revokeInvite } from "./revoke.js";

const companyA = kitIdentities.companies.a;
const companyB = kitIdentities.companies.b;

const fixtures = {
  inviteA: randomUUID(),
  inviteB: randomUUID(),
  missingId: randomUUID(),
};

const storedExpiresAt = new Date("2099-06-15T09:00:00.000Z");
const futureExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

let kit: TestKit;

function confirmationPipeline(target: TestKit): ActionPipelineDeps {
  return {
    ...target.pipeline,
    hooks: {
      ...target.pipeline.hooks,
      confirmation: createConfirmationHook({
        store: createInMemoryConfirmationStore(),
      }),
    },
  };
}

async function invokeForCard<
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
>(action: ImplementedAction<TInput, TOutput>, input: unknown) {
  return await kit
    .invoke(
      action,
      input,
      {},
      {
        deps: confirmationPipeline(kit),
        request: { requireConfirmation: true },
      },
    )
    .then(
      () => {
        throw new Error("expected the invocation to stop on a card");
      },
      (thrown: unknown) => thrown,
    );
}

async function previewOf<TInput extends z.ZodType, TOutput extends z.ZodType>(
  action: ImplementedAction<TInput, TOutput>,
  input: unknown,
): Promise<ActionPreview> {
  const error = await invokeForCard(action, input);
  if (!(error instanceof ConfirmationRequiredError)) {
    throw error;
  }
  const preview = error.challenge.preview;
  if (preview === undefined) {
    throw new Error("expected a structured preview card");
  }
  expect(error.challenge.summary).toBe(preview.title);
  return preview;
}

function expectSameRefusal(foreign: unknown, missing: unknown): void {
  if (
    !(foreign instanceof NotFoundError) ||
    !(missing instanceof NotFoundError)
  ) {
    throw foreign;
  }
  expect(foreign.code).toBe(missing.code);
  expect(foreign.clientMessage).toBe(missing.clientMessage);
}

beforeAll(async () => {
  kit = await createTestKit();

  await kit.db.runtime.db.insert(companyCustomerInvites).values([
    {
      id: fixtures.inviteA,
      companyId: companyA,
      invitedBy: kitIdentities.users.anna,
      tokenHash: `hash-${fixtures.inviteA}`,
      isReusable: true,
      maxUses: 5,
      usesCount: 2,
      expiresAt: storedExpiresAt,
      status: "pending",
      name: "Пекарня Оксани",
    },
    {
      id: fixtures.inviteB,
      companyId: companyB,
      invitedBy: kitIdentities.users.anna,
      tokenHash: `hash-${fixtures.inviteB}`,
      isReusable: false,
      maxUses: 1,
      usesCount: 0,
      expiresAt: storedExpiresAt,
      status: "pending",
      name: "Чужий клієнт",
    },
  ]);
});

afterAll(async () => {
  await kit.db.close();
});

describe("invites preview cards (core.md §7)", () => {
  it("previews invites.create from the validated input", async () => {
    const preview = await previewOf(createInvite, {
      isReusable: false,
      expiresAt: futureExpiresAt.toISOString(),
      name: "Нова пекарня",
    });
    expect(preview.title).toBe("Створити запрошення для клієнта");
    expect(preview.lines.slice(0, 3)).toEqual([
      { label: "Тип", value: "Персональне" },
      { label: "Ім'я", value: "Нова пекарня" },
      { label: "Використань", value: "1" },
    ]);
    expect(preview.lines[3]?.label).toBe("Діє до");
    expect(preview.lines[3]?.value).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
    expect(preview.notes).toEqual([
      "Посилання з таємним кодом буде показано один раз.",
    ]);
  });

  it("previews invites.revoke from the stored invite", async () => {
    const preview = await previewOf(revokeInvite, { id: fixtures.inviteA });
    expect(preview.title).toBe("Відкликати запрошення для Пекарня Оксани");
    expect(preview.lines).toEqual([
      { label: "Тип", value: "Багаторазове" },
      { label: "Статус", value: "Чинне" },
      { label: "Використань", value: "2 / 5" },
      { label: "Діє до", value: "15.06.2099" },
    ]);
  });

  it("leaves the invite untouched while the card is issued", async () => {
    const rows = await kit.db.runtime.db
      .select({ status: companyCustomerInvites.status })
      .from(companyCustomerInvites)
      .where(eq(companyCustomerInvites.id, fixtures.inviteA));
    expect(rows[0]?.status).toBe("pending");
  });

  it("refuses a foreign invite in the card exactly like a missing one", async () => {
    expectSameRefusal(
      await invokeForCard(revokeInvite, { id: fixtures.inviteB }),
      await invokeForCard(revokeInvite, { id: fixtures.missingId }),
    );
  });

  it("keeps another company's invite name out of the card", async () => {
    const refusal = await invokeForCard(revokeInvite, { id: fixtures.inviteB });
    expect(refusal).toBeInstanceOf(NotFoundError);
    expect(JSON.stringify(refusal)).not.toContain("Чужий клієнт");
  });
});
