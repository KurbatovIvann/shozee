import { describe, expect, it } from "vitest";

import { selectorLookupValue } from "../shared/option-select";
import {
  ensureLinkedCustomerOption,
  linkedCustomerName,
  mergePrefillCustomerName,
  pickedCustomerSnapshot,
} from "./counterparty-form-options";

const CUSTOMER_ID = "0f0e2d5c-4a1b-4c3d-9e8f-102938475601";

describe("ensureLinkedCustomerOption", () => {
  it("leaves options alone when standalone or already listed", () => {
    const options = [{ id: CUSTOMER_ID, name: "Марія" }];
    expect(
      ensureLinkedCustomerOption({
        options,
        customerId: null,
        customerName: "Марія",
        unnamedFallback: "Assigned",
      }),
    ).toBe(options);
    expect(
      ensureLinkedCustomerOption({
        options,
        customerId: CUSTOMER_ID,
        customerName: "Марія",
        unnamedFallback: "Assigned",
      }),
    ).toBe(options);
  });

  it("prepends a linked customer missing from the active picker list", () => {
    expect(
      ensureLinkedCustomerOption({
        options: [{ id: "other", name: "Олена" }],
        customerId: CUSTOMER_ID,
        customerName: "Марія",
        unnamedFallback: "Assigned",
      }),
    ).toEqual([
      { id: CUSTOMER_ID, name: "Марія" },
      { id: "other", name: "Олена" },
    ]);
    expect(
      ensureLinkedCustomerOption({
        options: [],
        customerId: CUSTOMER_ID,
        customerName: null,
        unnamedFallback: "Assigned",
      }),
    ).toEqual([{ id: CUSTOMER_ID, name: "Assigned" }]);
  });
});

describe("linkedCustomerName / mergePrefillCustomerName", () => {
  it("prefers getCounterparty.customerName, then create-from-client getCustomer.name", () => {
    expect(
      linkedCustomerName({
        fromCounterparty: "Марія",
        fromPrefillCustomer: "Олена",
      }),
    ).toBe("Марія");
    expect(
      linkedCustomerName({
        fromCounterparty: null,
        fromPrefillCustomer: "Марія",
      }),
    ).toBe("Марія");
    expect(
      linkedCustomerName({
        fromCounterparty: undefined,
        fromPrefillCustomer: undefined,
      }),
    ).toBeNull();
    expect(
      linkedCustomerName({
        fromCounterparty: "",
        fromPrefillCustomer: "",
      }),
    ).toBeNull();
  });

  it("seeds the lookup map and selector when the active list has not drained", () => {
    const names = mergePrefillCustomerName(new Map(), CUSTOMER_ID, "Марія");
    expect(names.get(CUSTOMER_ID)).toBe("Марія");
    expect(mergePrefillCustomerName(names, CUSTOMER_ID, "Олена")).toBe(names);
    expect(mergePrefillCustomerName(names, null, "Марія")).toBe(names);
    const customerName = linkedCustomerName({
      fromCounterparty: undefined,
      fromPrefillCustomer: "Марія",
    });
    expect(selectorLookupValue(CUSTOMER_ID, names, "Assigned")).toBe("Марія");
    expect(
      selectorLookupValue(CUSTOMER_ID, new Map(), customerName ?? "Assigned"),
    ).toBe("Марія");
    expect(
      ensureLinkedCustomerOption({
        options: [],
        customerId: CUSTOMER_ID,
        customerName,
        unnamedFallback: "Assigned",
      }),
    ).toEqual([{ id: CUSTOMER_ID, name: "Марія" }]);
  });
});

describe("pickedCustomerSnapshot", () => {
  const options = [{ id: CUSTOMER_ID, name: "Марія" }];

  it("snapshots the picked customer's name at pick time", () => {
    expect(pickedCustomerSnapshot(CUSTOMER_ID, options)).toEqual({
      id: CUSTOMER_ID,
      name: "Марія",
    });
  });

  it("clears the snapshot when the staff picks no client", () => {
    expect(pickedCustomerSnapshot(null, options)).toBeNull();
  });

  it("clears the snapshot when the id is not in the loaded options", () => {
    expect(pickedCustomerSnapshot("missing", options)).toBeNull();
  });
});
