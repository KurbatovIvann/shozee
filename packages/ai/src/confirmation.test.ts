import { describe, expect, it } from "vitest";

import {
  presentConfirmationDoneSpeech,
  STAFF_ASSISTANT_CONFIRMATION_DONE_COPY,
  STAFF_ASSISTANT_CONFIRMATION_DONE_FALLBACK,
} from "./confirmation.js";

describe("presentConfirmationDoneSpeech", () => {
  it("returns protocol copy for each confirmed write", () => {
    expect(
      presentConfirmationDoneSpeech({
        locale: "uk",
        actionName: "customers.deleteCustomer",
      }),
    ).toBe(
      STAFF_ASSISTANT_CONFIRMATION_DONE_COPY["customers.deleteCustomer"].uk,
    );
    expect(
      presentConfirmationDoneSpeech({
        locale: "en",
        actionName: "customers.deleteGroup",
      }),
    ).toBe(STAFF_ASSISTANT_CONFIRMATION_DONE_COPY["customers.deleteGroup"].en);
    expect(
      presentConfirmationDoneSpeech({
        locale: "uk",
        actionName: "customers.deleteCounterparty",
      }),
    ).toBe(
      STAFF_ASSISTANT_CONFIRMATION_DONE_COPY["customers.deleteCounterparty"].uk,
    );
    expect(
      presentConfirmationDoneSpeech({
        locale: "uk",
        actionName: "pricing.deletePriceList",
      }),
    ).toBe(
      STAFF_ASSISTANT_CONFIRMATION_DONE_COPY["pricing.deletePriceList"].uk,
    );
    expect(
      presentConfirmationDoneSpeech({
        locale: "uk",
        actionName: "documents.requestSign",
      }),
    ).toBe(STAFF_ASSISTANT_CONFIRMATION_DONE_COPY["documents.requestSign"].uk);
  });

  it("falls back when the action is unknown", () => {
    expect(
      presentConfirmationDoneSpeech({
        locale: "uk",
        actionName: "orders.create",
      }),
    ).toBe(STAFF_ASSISTANT_CONFIRMATION_DONE_FALLBACK.uk);
    expect(
      presentConfirmationDoneSpeech({
        locale: "en",
        actionName: "orders.create",
      }),
    ).toBe(STAFF_ASSISTANT_CONFIRMATION_DONE_FALLBACK.en);
  });
});
