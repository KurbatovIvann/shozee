import { toProviderToolName } from "@showzy/ai";
import {
  archiveProductContract,
  archiveVariantContract,
  createProductContract,
  createVariantContract,
  restoreProductContract,
  restoreVariantContract,
  updateProductContract,
  updateVariantContract,
} from "@showzy/catalog/contract";
import {
  shoCommandSchema,
  shoResultSchema,
  type ShoCommand,
  type ShoResult,
} from "@showzy/sho-protocol";
import { describe, expect, it } from "vitest";

import { createShoPlanner, type ShoActionPlan } from "../sho-plan.js";

import { shoCatalogWriteParse } from "./__tests__/catalog-write-parses.js";
import {
  SHO_ARCHIVE_PRODUCT,
  SHO_ARCHIVE_VARIANT,
  SHO_CATALOG_WRITE_ACTIONS,
  SHO_CATALOG_WRITE_PLANNERS,
  SHO_CATALOG_WRITE_PLANNER_PARAMS,
  SHO_CREATE_PRODUCT,
  SHO_CREATE_VARIANT,
  SHO_READ_AS_FOCUS_PRODUCT_NOTE,
  SHO_READ_AS_PRODUCT_UPDATE_NOTE,
  SHO_READ_AS_VARIANT_UPDATE_NOTE,
  SHO_RESTORE_PRODUCT,
  SHO_RESTORE_VARIANT,
  SHO_UNKNOWN_VARIANT_ATTR_NOTE,
  SHO_UPDATE_PRODUCT,
  SHO_UPDATE_VARIANT,
} from "./catalog-writes.js";
import { SHO_READ_ACTIONS } from "./reads.js";

const NOW = new Date("2026-09-02T12:00:00.000Z");

const OVER_THE_FLOOR = {
  action: 0.99,
  margin: 0.8,
  certainty: 0.9,
  spans: 0.9,
};

const OUR_PRODUCT = "3f8c1b05-6d47-4e92-a013-7b5e9c82df41";

type Json = Record<string, unknown>;

const parseOf = (caseId: string): Json =>
  JSON.parse(JSON.stringify(shoCatalogWriteParse(caseId))) as Json;

const paramsOf = (caseId: string): Json => parseOf(caseId)["params"] as Json;

const suggestedCreate = (): Json =>
  ((paramsOf("d78-unknown-priced")["product"] as Json)["suggest"] as Json)[
    "params"
  ] as Json;

const productRef = (id: string): Json => ({
  ...(paramsOf("d89-archive-product")["product"] as Json),
  id,
});

function commandOf(caseId: string, patch: Json = {}): ShoCommand {
  return shoCommandSchema.parse({
    confidence: OVER_THE_FLOOR,
    ...parseOf(caseId),
    ...patch,
  });
}

function resultOf(command: ShoCommand): ShoResult {
  return shoResultSchema.parse({
    schema: "sho-result/2",
    raw: null,
    text: command.text,
    segments: [command.text],
    tooMany: false,
    commands: [command],
    first: command,
    context: { version: 1, revision: null },
  });
}

const TOOL_INPUTS: Readonly<Record<string, (input: unknown) => boolean>> = {
  [toProviderToolName(createProductContract.name)]: (input) =>
    createProductContract.input.safeParse(input).success,
  [toProviderToolName(updateProductContract.name)]: (input) =>
    updateProductContract.input.safeParse(input).success,
  [toProviderToolName(archiveProductContract.name)]: (input) =>
    archiveProductContract.input.safeParse(input).success,
  [toProviderToolName(restoreProductContract.name)]: (input) =>
    restoreProductContract.input.safeParse(input).success,
  [toProviderToolName(createVariantContract.name)]: (input) =>
    createVariantContract.input.safeParse(input).success,
  [toProviderToolName(updateVariantContract.name)]: (input) =>
    updateVariantContract.input.safeParse(input).success,
  [toProviderToolName(archiveVariantContract.name)]: (input) =>
    archiveVariantContract.input.safeParse(input).success,
  [toProviderToolName(restoreVariantContract.name)]: (input) =>
    restoreVariantContract.input.safeParse(input).success,
};

function toolAccepts(toolName: string, input: unknown): boolean {
  const accepts = TOOL_INPUTS[toolName];
  if (accepts === undefined) {
    throw new Error(`no action input schema for ${toolName}`);
  }
  return accepts(input);
}

function planOf(command: ShoCommand): ShoActionPlan {
  const planner = SHO_CATALOG_WRITE_PLANNERS[command.action];
  if (planner === undefined) {
    throw new Error(`no catalog write planner for ${command.action}`);
  }
  const plan = planner.plan(command, NOW);
  if (plan.kind === "call") {
    expect({
      action: command.action,
      accepted: toolAccepts(plan.toolName, plan.input),
    }).toEqual({ action: command.action, accepted: true });
  }
  return plan;
}

const notesOf = (plan: ShoActionPlan): unknown =>
  plan.kind === "call" ? plan.notes : "not a call";

const whitelisted = createShoPlanner({
  actions: [...SHO_READ_ACTIONS, ...SHO_CATALOG_WRITE_ACTIONS],
});

const creating = (patch: Json = {}): ShoCommand =>
  commandOf("d78-unknown-priced", {
    action: SHO_CREATE_PRODUCT,
    verb: "create",
    params: { ...suggestedCreate(), ...patch },
    needs: [],
    ready: true,
  });

const updating = (params: Json, patch: Json = {}): ShoCommand =>
  commandOf("d78-unknown-priced", {
    params,
    needs: [],
    ready: true,
    ...patch,
  });

describe("catalog.createProduct plans the price the staff member spoke", () => {
  it("plans the d78-unknown-priced create Шо itself suggests", () => {
    expect(planOf(creating())).toEqual({
      kind: "call",
      toolName: "catalog_createProduct",
      reply: "Товар створено.",
      input: {
        name: "куртку шкіряну",
        basePriceMinor: "120000",
        currency: "UAH",
      },
    });
  });

  it("names the product in the nominative the runtime read", () => {
    expect(
      planOf(
        commandOf("d78-unknown-priced", {
          action: SHO_CREATE_PRODUCT,
          verb: "create",
          params: suggestedCreate(),
          needs: [],
          ready: true,
          creates: { type: "product", name: "Куртка шкіряна" },
        }),
      ),
    ).toEqual({
      kind: "call",
      toolName: "catalog_createProduct",
      reply: "Товар створено.",
      input: {
        name: "Куртка шкіряна",
        basePriceMinor: "120000",
        currency: "UAH",
      },
    });
  });

  it("asks rather than guess a price the parse never heard", () => {
    expect(
      planOf(
        commandOf("d78-unknown-priced", {
          action: SHO_CREATE_PRODUCT,
          verb: "create",
          params: { new_name: suggestedCreate()["new_name"] },
          needs: [],
          ready: true,
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "blocking_need" });
  });

  it("stamps the write once, so the turn reaches the preview", () => {
    expect(whitelisted(resultOf(creating()), NOW)).toEqual({
      kind: "call",
      toolName: "catalog_createProduct",
      reply: "Товар створено.",
      input: {
        name: "куртку шкіряну",
        basePriceMinor: "120000",
        currency: "UAH",
      },
      writes: true,
    });
  });
});

describe("catalog.updateProduct sends the resolved product and what was said", () => {
  it("plans the d78-unknown-priced price onto the product the focus holds", () => {
    expect(
      planOf(
        updating({
          product: productRef(OUR_PRODUCT),
          price: paramsOf("d78-unknown-priced")["price"],
        }),
      ),
    ).toEqual({
      kind: "call",
      toolName: "catalog_updateProduct",
      reply: "Товар оновлено.",
      input: {
        productId: OUR_PRODUCT,
        basePriceMinor: "120000",
        currency: "UAH",
      },
    });
  });

  it("sends no price for a d89-rename-group rename, so the stored price stands", () => {
    expect(
      planOf(
        updating({
          product: productRef(OUR_PRODUCT),
          rename_to: paramsOf("d89-rename-group")["rename_to"],
        }),
      ),
    ).toEqual({
      kind: "call",
      toolName: "catalog_updateProduct",
      reply: "Товар оновлено.",
      input: { productId: OUR_PRODUCT, name: "квітникарі" },
    });
  });

  it("asks rather than plan an empty card when the parse names only the product", () => {
    expect(planOf(updating({ product: productRef(OUR_PRODUCT) }))).toEqual({
      kind: "fallback",
      reason: "blocking_need",
    });
  });

  it("sends the gold d78-unknown-priced to the LLM: the list knows no such product", () => {
    expect(whitelisted(resultOf(commandOf("d78-unknown-priced")), NOW)).toEqual(
      { kind: "fallback", reason: "unresolved_reference" },
    );
  });
});

describe("the archive and restore of a product take the record alone", () => {
  it("plans the gold d89-archive-product on the focused product", () => {
    expect(
      planOf(
        commandOf("d89-archive-product", {
          params: { product: productRef(OUR_PRODUCT) },
        }),
      ),
    ).toEqual({
      kind: "call",
      toolName: "catalog_archiveProduct",
      reply: "Товар заархівовано.",
      input: { productId: OUR_PRODUCT },
      notes: [`${SHO_READ_AS_FOCUS_PRODUCT_NOTE}: «його».`],
    });
  });

  it("restores d89-archive-product's product: no gold restore parse resolves one", () => {
    expect(
      planOf(
        commandOf("d89-archive-product", {
          action: SHO_RESTORE_PRODUCT,
          verb: "restore",
          params: { product: productRef(OUR_PRODUCT) },
          needs: [],
        }),
      ),
    ).toEqual({
      kind: "call",
      toolName: "catalog_restoreProduct",
      reply: "Товар повернуто з архіву.",
      input: { productId: OUR_PRODUCT },
    });
  });

  it("maps no param beyond the record for an archive", () => {
    expect(
      planOf(
        commandOf("d89-archive-product", {
          params: {
            product: productRef(OUR_PRODUCT),
            price: paramsOf("d78-unknown-priced")["price"],
          },
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });

  it("keeps the misread note on the write the preview pauses", () => {
    expect(
      whitelisted(
        resultOf(
          commandOf("d89-archive-product", {
            params: { product: productRef(OUR_PRODUCT) },
          }),
        ),
        NOW,
      ),
    ).toMatchObject({
      kind: "call",
      toolName: "catalog_archiveProduct",
      input: { productId: OUR_PRODUCT },
      writes: true,
      notes: [`${SHO_READ_AS_FOCUS_PRODUCT_NOTE}: «його».`],
    });
  });

  it("carries no note when the parse reports no misread", () => {
    expect(
      notesOf(
        planOf(
          commandOf("d89-archive-product", {
            params: { product: productRef(OUR_PRODUCT) },
            needs: [],
          }),
        ),
      ),
    ).toBeUndefined();
  });

  it("notes a D84 misread on an update as an edit, not a create", () => {
    expect(
      notesOf(
        planOf(
          updating(
            {
              product: productRef(OUR_PRODUCT),
              rename_to: paramsOf("d89-rename-group")["rename_to"],
            },
            {
              needs: [
                {
                  path: "action",
                  reason: "read_as_update",
                  blocking: false,
                  span: { text: "куртку шкіряну" },
                },
              ],
            },
          ),
        ),
      ),
    ).toEqual([`${SHO_READ_AS_PRODUCT_UPDATE_NOTE}: «куртку шкіряну».`]);
  });
});

describe("a catalog write binds no record and no money the parse did not give", () => {
  it("refuses the catalogue's own record ids, which are no uuids", () => {
    expect(planOf(commandOf("d89-archive-product"))).toEqual({
      kind: "fallback",
      reason: "unsupported_param",
    });
  });

  it("refuses a product named rather than resolved", () => {
    expect(
      planOf(
        commandOf("d89-archive-product", {
          params: {
            product: {
              text: "куртку шкіряну",
              status: "unknown",
              candidates: [{ id: "p-jacket", name: "Куртка шкіряна" }],
            },
          },
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });

  it("refuses half a price pair rather than send a bare number", () => {
    expect(
      planOf(
        updating({
          product: productRef(OUR_PRODUCT),
          price: { text: "1200", value: { minor: null, currency: "UAH" } },
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });

  it("re-parses no money text of its own", () => {
    expect(
      planOf(
        updating({
          product: productRef(OUR_PRODUCT),
          price: { text: "1200 гривень" },
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });

  it("refuses a currency the catalog does not price in", () => {
    expect(
      planOf(
        updating({
          product: productRef(OUR_PRODUCT),
          price: {
            text: "1200 євро",
            value: { minor: 120000, currency: "EUR" },
          },
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });
});

describe("a param the catalog has no column for is refused, never dropped", () => {
  const UNSUPPORTED: Readonly<Record<string, Json>> = {
    unit: { text: "мішок", value: "bag" },
    brand: { text: "нівея" },
  };

  it("sends a create carrying a unit or a brand to the LLM", () => {
    for (const [name, param] of Object.entries(UNSUPPORTED)) {
      expect({ name, plan: planOf(creating({ [name]: param })) }).toEqual({
        name,
        plan: { kind: "fallback", reason: "unsupported_param" },
      });
    }
  });
});

describe("the catalog write planners are registered as writes", () => {
  it("declares writes on every planner", () => {
    for (const action of SHO_CATALOG_WRITE_ACTIONS) {
      expect({
        action,
        writes: SHO_CATALOG_WRITE_PLANNERS[action]?.writes,
      }).toEqual({ action, writes: true });
    }
  });

  it("names the eight catalog writes and their catalogue params", () => {
    expect(SHO_CATALOG_WRITE_PLANNER_PARAMS).toEqual({
      [SHO_CREATE_PRODUCT]: ["new_name", "price"],
      [SHO_UPDATE_PRODUCT]: ["product", "rename_to", "price"],
      [SHO_ARCHIVE_PRODUCT]: ["product"],
      [SHO_RESTORE_PRODUCT]: ["product"],
      [SHO_CREATE_VARIANT]: ["product", "new_name", "price"],
      [SHO_UPDATE_VARIANT]: ["variant", "product", "rename_to", "price"],
      [SHO_ARCHIVE_VARIANT]: ["variant", "product"],
      [SHO_RESTORE_VARIANT]: ["variant", "product"],
    });
  });

  it("plans none of them while the deployment has not named them", () => {
    expect(
      createShoPlanner({ actions: [...SHO_READ_ACTIONS] })(
        resultOf(creating()),
        NOW,
      ),
    ).toEqual({ kind: "fallback", reason: "not_whitelisted" });
  });
});

const OUR_VARIANT = "6b1d94a7-52c8-4f30-9ad6-18e7c45b0f29";

const GOLD_VARIANT_CASE = "d79-price-list-case";

const goldParent = (): Json => paramsOf(GOLD_VARIANT_CASE)["product"] as Json;

const goldVariant = (): Json => paramsOf(GOLD_VARIANT_CASE)["variant"] as Json;

const parentRef = (id: string): Json => ({ ...goldParent(), id });

const variantRef = (id: string, patch: Json = {}): Json => ({
  ...goldVariant(),
  id,
  ...patch,
});

const onTheVariant = (
  action: string,
  params: Json,
  patch: Json = {},
): ShoCommand => commandOf(GOLD_VARIANT_CASE, { action, params, ...patch });

const ourVariant = (): Json => ({
  variant: variantRef(OUR_VARIANT),
  product: parentRef(OUR_PRODUCT),
});

describe("a variant write names the parent product the parse bound", () => {
  it("creates a variant on the gold d79-price-list-case product: no gold parse creates one", () => {
    expect(
      planOf(
        onTheVariant(SHO_CREATE_VARIANT, {
          product: parentRef(OUR_PRODUCT),
          new_name: suggestedCreate()["new_name"],
          price: suggestedCreate()["price"],
        }),
      ),
    ).toEqual({
      kind: "call",
      toolName: "catalog_createVariant",
      reply: "Варіант створено.",
      input: {
        productId: OUR_PRODUCT,
        name: "куртку шкіряну",
        basePriceMinor: "120000",
        currency: "UAH",
      },
    });
  });

  it("creates the variant without an override when no price was spoken", () => {
    expect(
      planOf(
        onTheVariant(SHO_CREATE_VARIANT, {
          product: parentRef(OUR_PRODUCT),
          new_name: suggestedCreate()["new_name"],
        }),
      ),
    ).toEqual({
      kind: "call",
      toolName: "catalog_createVariant",
      reply: "Варіант створено.",
      input: { productId: OUR_PRODUCT, name: "куртку шкіряну" },
    });
  });

  it("creates a variant on the product the focus holds: no variant is scoped by it", () => {
    expect(
      planOf(
        onTheVariant(SHO_CREATE_VARIANT, {
          product: productRef(OUR_PRODUCT),
          new_name: suggestedCreate()["new_name"],
        }),
      ),
    ).toEqual({
      kind: "call",
      toolName: "catalog_createVariant",
      reply: "Варіант створено.",
      input: { productId: OUR_PRODUCT, name: "куртку шкіряну" },
    });
  });

  it("asks rather than guess the parent of a created variant", () => {
    expect(
      planOf(
        onTheVariant(SHO_CREATE_VARIANT, {
          new_name: suggestedCreate()["new_name"],
          price: suggestedCreate()["price"],
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "blocking_need" });
  });

  it("asks rather than guess the parent of an updated variant", () => {
    expect(
      planOf(
        onTheVariant(SHO_UPDATE_VARIANT, {
          variant: variantRef(OUR_VARIANT),
          rename_to: paramsOf("d89-rename-group")["rename_to"],
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "blocking_need" });
  });
});

describe("a variant update sends the variant and only the fields said", () => {
  it("sends no price for a rename, so the stored override stands", () => {
    expect(
      planOf(
        onTheVariant(SHO_UPDATE_VARIANT, {
          ...ourVariant(),
          rename_to: paramsOf("d89-rename-group")["rename_to"],
        }),
      ),
    ).toEqual({
      kind: "call",
      toolName: "catalog_updateVariant",
      reply: "Варіант оновлено.",
      input: {
        productId: OUR_PRODUCT,
        variantId: OUR_VARIANT,
        name: "квітникарі",
      },
    });
  });

  it("sends the override as the price and currency pair Шо parsed", () => {
    expect(
      planOf(
        onTheVariant(SHO_UPDATE_VARIANT, {
          ...ourVariant(),
          price: suggestedCreate()["price"],
        }),
      ),
    ).toEqual({
      kind: "call",
      toolName: "catalog_updateVariant",
      reply: "Варіант оновлено.",
      input: {
        productId: OUR_PRODUCT,
        variantId: OUR_VARIANT,
        basePriceMinor: "120000",
        currency: "UAH",
      },
    });
  });

  it("asks rather than plan an empty card when only the variant was named", () => {
    expect(planOf(onTheVariant(SHO_UPDATE_VARIANT, ourVariant()))).toEqual({
      kind: "fallback",
      reason: "blocking_need",
    });
  });

  it("refuses half an override pair rather than send a bare number", () => {
    expect(
      planOf(
        onTheVariant(SHO_UPDATE_VARIANT, {
          ...ourVariant(),
          price: { text: "1200 гривень" },
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });

  it("notes a D84 misread of a variant update read as an edit", () => {
    expect(
      notesOf(
        planOf(
          onTheVariant(
            SHO_UPDATE_VARIANT,
            {
              ...ourVariant(),
              rename_to: paramsOf("d89-rename-group")["rename_to"],
            },
            {
              needs: [
                {
                  path: "action",
                  reason: "read_as_update",
                  blocking: false,
                  span: { text: "темно-синє xl" },
                },
              ],
            },
          ),
        ),
      ),
    ).toEqual([`${SHO_READ_AS_VARIANT_UPDATE_NOTE}: «темно-синє xl».`]);
  });
});

describe("the archive and restore of a variant take the variant alone", () => {
  const LIFECYCLE: Readonly<Record<string, readonly [string, string]>> = {
    [SHO_ARCHIVE_VARIANT]: ["catalog_archiveVariant", "Варіант заархівовано."],
    [SHO_RESTORE_VARIANT]: [
      "catalog_restoreVariant",
      "Варіант повернуто з архіву.",
    ],
  };

  it("plans the variant id and drops the parent that located it", () => {
    for (const [action, [toolName, reply]] of Object.entries(LIFECYCLE)) {
      expect({
        action,
        plan: planOf(onTheVariant(action, ourVariant())),
      }).toEqual({
        action,
        plan: {
          kind: "call",
          toolName,
          reply,
          input: { variantId: OUR_VARIANT },
        },
      });
    }
  });

  it("refuses a parent the parse never bound", () => {
    for (const action of Object.keys(LIFECYCLE)) {
      expect({
        action,
        plan: planOf(
          onTheVariant(action, {
            variant: variantRef(OUR_VARIANT),
            product: { text: "поло kappa", status: "unknown" },
          }),
        ),
      }).toEqual({
        action,
        plan: { kind: "fallback", reason: "unsupported_param" },
      });
    }
  });

  it("notes an attr no variant of the product carries", () => {
    expect(
      notesOf(
        planOf(
          onTheVariant(SHO_ARCHIVE_VARIANT, ourVariant(), {
            needs: [
              {
                path: "variant.attrs[1]",
                reason: "unknown_attr",
                blocking: false,
              },
            ],
          }),
        ),
      ),
    ).toEqual([`${SHO_UNKNOWN_VARIANT_ATTR_NOTE}.`]);
  });
});

describe("a variant write binds no variant the parse did not resolve", () => {
  it("refuses the gold d79-price-list-case ids, which are no uuids", () => {
    expect(
      planOf(
        onTheVariant(SHO_ARCHIVE_VARIANT, {
          variant: goldVariant(),
          product: goldParent(),
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });

  it("refuses a foreign product id beside a resolved variant", () => {
    expect(
      planOf(
        onTheVariant(SHO_ARCHIVE_VARIANT, {
          variant: variantRef(OUR_VARIANT),
          product: goldParent(),
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });

  it("refuses a focus-held parent beside a variant the attrs resolved", () => {
    for (const action of [
      SHO_UPDATE_VARIANT,
      SHO_ARCHIVE_VARIANT,
      SHO_RESTORE_VARIANT,
    ]) {
      expect({
        action,
        plan: planOf(
          onTheVariant(action, {
            variant: variantRef(OUR_VARIANT),
            product: productRef(OUR_PRODUCT),
          }),
        ),
      }).toEqual({
        action,
        plan: { kind: "fallback", reason: "unsupported_param" },
      });
    }
  });

  it("never guesses between the variants the attrs name", () => {
    for (const status of ["ambiguous", "unknown", "unspecified", "none"]) {
      expect({
        status,
        plan: planOf(
          onTheVariant(SHO_ARCHIVE_VARIANT, {
            variant: variantRef(OUR_VARIANT, { status }),
            product: parentRef(OUR_PRODUCT),
          }),
        ),
      }).toEqual({
        status,
        plan: { kind: "fallback", reason: "unsupported_param" },
      });
    }
  });

  it("refuses the product as a stand-in for the variant", () => {
    expect(
      planOf(
        onTheVariant(SHO_ARCHIVE_VARIANT, {
          variant: parentRef(OUR_PRODUCT),
          product: parentRef(OUR_PRODUCT),
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });
});
