import { describe, expect, it } from "vitest";

import { createActionRegistry } from "./registry.js";

const WRITTEN_RECORD_ID_FIELDS = new Map<string, string>([
  ["orders.create", "orderId"],
  ["orders.confirm", "orderId"],
  ["orders.start", "orderId"],
  ["orders.complete", "orderId"],
  ["orders.cancel", "orderId"],
  ["customers.createCustomer", "id"],
  ["customers.updateCustomer", "id"],
  ["customers.archiveCustomer", "id"],
  ["customers.restoreCustomer", "id"],
  ["customers.createGroup", "id"],
  ["customers.updateGroup", "id"],
  ["customers.createCounterparty", "id"],
  ["customers.updateCounterparty", "id"],
  ["catalog.createProduct", "productId"],
  ["catalog.updateProduct", "productId"],
  ["catalog.archiveProduct", "productId"],
  ["catalog.restoreProduct", "productId"],
  ["pricing.createPriceList", "id"],
  ["pricing.updatePriceList", "id"],
  ["pricing.activatePriceList", "id"],
  ["pricing.deactivatePriceList", "id"],
  ["pricing.setDefaultPriceList", "id"],
]);

describe("the record an assistant write leaves in its trace", () => {
  it("is named by the result field each of those actions declares", () => {
    const registry = createActionRegistry();

    for (const [action, field] of WRITTEN_RECORD_ID_FIELDS) {
      expect(registry.getContract(action)?.writtenRecordIdField, action).toBe(
        field,
      );
    }
  });
});
