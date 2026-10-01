import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  hidePriceListOptions,
  IDLE_PRICE_LIST_OPTIONS,
  openPriceListOptions,
  optionsFollowUpWaitsForHidden,
  planPriceListOptionsFollowUp,
  priceListOptionsHidden,
  runPriceListOptionsFollowUp,
} from "./price-list-options-handshake";

const LIST_ID = "0f0e2d5c-4a1b-4c3d-9e8f-102938475601";

const HOOK_SOURCE = readFileSync(
  new URL("./use-price-lists-list.ts", import.meta.url),
  "utf8",
);

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("price-list options chrome", () => {
  it("keeps the selected list while visible becomes false", () => {
    const open = openPriceListOptions(LIST_ID);
    expect(open).toEqual({ visible: true, listId: LIST_ID });
    const hidden = hidePriceListOptions(open);
    expect(hidden.visible).toBe(false);
    expect(hidden.listId).toBe(LIST_ID);
  });

  it("clears the selected list on onHidden only after close", () => {
    const closing = hidePriceListOptions(openPriceListOptions(LIST_ID));
    expect(priceListOptionsHidden(closing)).toEqual(IDLE_PRICE_LIST_OPTIONS);
  });

  it("does not drop a list that was reopened before a late onHidden", () => {
    const reopened = openPriceListOptions(LIST_ID);
    expect(priceListOptionsHidden(reopened)).toEqual(reopened);
  });
});

describe("planPriceListOptionsFollowUp", () => {
  it("waits for delete and deactivate-default, not for other writes", () => {
    expect(
      planPriceListOptionsFollowUp({
        action: "delete",
        isDefault: false,
        isActive: true,
      }),
    ).toEqual({ kind: "delete" });
    expect(
      planPriceListOptionsFollowUp({
        action: "toggleActive",
        isDefault: true,
        isActive: true,
      }),
    ).toEqual({ kind: "blockDeactivateDefault" });
    expect(
      planPriceListOptionsFollowUp({
        action: "toggleActive",
        isDefault: false,
        isActive: true,
      }),
    ).toEqual({ kind: "toggleActive" });
    expect(
      planPriceListOptionsFollowUp({
        action: "setDefault",
        isDefault: false,
        isActive: true,
      }),
    ).toEqual({ kind: "setDefault" });
    expect(optionsFollowUpWaitsForHidden({ kind: "delete" })).toBe(true);
    expect(
      optionsFollowUpWaitsForHidden({ kind: "blockDeactivateDefault" }),
    ).toBe(true);
    expect(optionsFollowUpWaitsForHidden({ kind: "toggleActive" })).toBe(false);
    expect(optionsFollowUpWaitsForHidden({ kind: "setDefault" })).toBe(false);
  });
});

describe("runPriceListOptionsFollowUp", () => {
  it("delete waits for sheet hidden before the server card write", async () => {
    let chrome = openPriceListOptions(LIST_ID);
    const events: string[] = [];
    const gate = deferred();
    const deleteOnServerCard = vi.fn(() => {
      events.push("deleteOnServerCard");
      return Promise.resolve();
    });

    const done = runPriceListOptionsFollowUp({
      kind: "delete",
      waitHidden: () => {
        events.push("wait");
        return gate.promise;
      },
      hide: () => {
        chrome = hidePriceListOptions(chrome);
        events.push("hide");
      },
      deleteOnServerCard,
    });

    await Promise.resolve();
    expect(events).toEqual(["wait", "hide"]);
    expect(chrome.visible).toBe(false);
    expect(chrome.listId).toBe(LIST_ID);
    expect(deleteOnServerCard).not.toHaveBeenCalled();

    gate.resolve();
    await done;
    expect(deleteOnServerCard).toHaveBeenCalledOnce();
    expect(events).toEqual(["wait", "hide", "deleteOnServerCard"]);
  });

  it("deactivate-default sets Banner only after hide and never submits", async () => {
    const followUp = planPriceListOptionsFollowUp({
      action: "toggleActive",
      isDefault: true,
      isActive: true,
    });
    expect(followUp.kind).toBe("blockDeactivateDefault");
    expect(optionsFollowUpWaitsForHidden(followUp)).toBe(true);

    let chrome = openPriceListOptions(LIST_ID);
    let banner: string | null = null;
    const gate = deferred();

    const done = runPriceListOptionsFollowUp({
      kind: "blockDeactivateDefault",
      waitHidden: () => gate.promise,
      hide: () => {
        chrome = hidePriceListOptions(chrome);
      },
      setBanner: (message) => {
        banner = message;
      },
      message: "cannot-deactivate-default",
    });

    await Promise.resolve();
    expect(chrome.visible).toBe(false);
    expect(banner).toBeNull();

    gate.resolve();
    await done;
    expect(chrome.visible).toBe(false);
    expect(banner).toBe("cannot-deactivate-default");
  });
});

describe("live hook wiring (SHO-200)", () => {
  it("stores PriceListOptionsChrome and applies the chrome helpers", () => {
    expect(HOOK_SOURCE).toContain("PriceListOptionsChrome");
    expect(HOOK_SOURCE).toContain("openPriceListOptions");
    expect(HOOK_SOURCE).toContain("hidePriceListOptions");
    expect(HOOK_SOURCE).toContain("priceListOptionsHidden");
    expect(HOOK_SOURCE).toContain("optionsHidden.notify()");
    expect(HOOK_SOURCE).not.toContain("optionsVisibleRef");
  });

  it("calls the follow-up with live ports, not a bypass then into writes", () => {
    expect(HOOK_SOURCE).toContain("runPriceListOptionsFollowUp");
    expect(HOOK_SOURCE).toContain("deleteOnServerCard");
    expect(HOOK_SOURCE).not.toContain("presentConfirmDialog");
    expect(HOOK_SOURCE).toContain("setBanner");
    expect(HOOK_SOURCE).not.toContain("submitDeactivate");
    expect(HOOK_SOURCE).toContain("const openOptions = useCallback");
    expect(HOOK_SOURCE).not.toContain("runAfterOptionsSheetHidden");
    expect(HOOK_SOURCE).not.toMatch(
      /then:\s*\(\)\s*=>\s*writes\.(remove|toggleActive)/,
    );
  });
});

describe("list write callback stability (SHO-304)", () => {
  it("stabilizes openEdit with useCallback", () => {
    const writes = readFileSync(
      new URL("./use-price-list-writes.ts", import.meta.url),
      "utf8",
    );
    expect(writes).toContain("const openEdit = useCallback");
    expect(writes).toContain("const openCreate = useCallback");
  });
});
