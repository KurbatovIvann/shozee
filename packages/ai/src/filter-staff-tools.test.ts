import { defineActionContract } from "@showzy/core/contract";
import type { StaffMembership } from "@showzy/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { filterStaffAiTools } from "./filter-staff-tools.js";

const readDefaults = {
  input: z.object({}),
  output: z.object({}),
  risk: "read" as const,
  requiresConfirmation: false,
  idempotent: false,
  emits: [] as const,
  atomicCalls: [] as const,
  atomicCallers: [] as const,
  errors: [],
  audit: false,
  timeout: 5_000,
};

const staffList = defineActionContract({
  ...readDefaults,
  name: "orders.list",
  errors: ["VALIDATION"],
  description: "List orders in the active company.",
  principal: "staff",
  transport: "client",
  aiExposure: "exposed",
  permissions: ["orders:view"],
});

const deleteCustomer = defineActionContract({
  ...readDefaults,
  name: "customers.deleteCustomer",
  errors: ["VALIDATION", "NOT_FOUND"],
  description: "Hard-delete an archived CRM customer. Requires confirmation.",
  principal: "staff",
  transport: "client",
  aiExposure: "exposed",
  permissions: ["customers:delete"],
  risk: "high",
  requiresConfirmation: true,
  idempotent: true,
  audit: true,
  input: z.object({ id: z.uuid() }),
  output: z.object({ id: z.uuid() }),
});

const staffInternal = defineActionContract({
  ...readDefaults,
  name: "assistant.recordAssistantTurn",
  errors: ["VALIDATION", "NOT_FOUND"],
  description: "Internal assistant persistence — never an AI tool.",
  principal: "staff",
  transport: "internal",
  aiExposure: "internal",
  permissions: ["assistant:use"],
  risk: "write",
  idempotent: true,
  audit: true,
});

const staffHiddenClient = defineActionContract({
  ...readDefaults,
  name: "docSigning.start",
  errors: ["VALIDATION", "NOT_FOUND", "CONFLICT"],
  description: "Client action deliberately kept away from models.",
  principal: "staff",
  transport: "client",
  aiExposure: "internal",
  permissions: ["documents:sign"],
});

const consumerExposed = defineActionContract({
  ...readDefaults,
  name: "sample.browse",
  description: "Consumer discovery tool.",
  principal: "consumer",
  transport: "client",
  aiExposure: "exposed",
  permissions: [],
});

const shareWrite = defineActionContract({
  ...readDefaults,
  name: "sample.submitShare",
  description: "Share-token write — never an AI tool.",
  principal: "share",
  transport: "client",
  aiExposure: "internal",
  risk: "write",
  idempotent: true,
  audit: true,
  permissions: [],
  input: z.object({ token: z.string().min(1), documentId: z.uuid() }),
  output: z.object({ ok: z.boolean() }),
});

const systemInternal = defineActionContract({
  ...readDefaults,
  name: "sample.internalJob",
  description: "Internal system job — never an AI tool.",
  principal: "system",
  transport: "internal",
  systemScope: "tenant",
  aiExposure: "internal",
  permissions: [],
});

const all = [
  staffList,
  deleteCustomer,
  staffInternal,
  staffHiddenClient,
  consumerExposed,
  shareWrite,
  systemInternal,
];

const owner: StaffMembership = { role: "owner", permissions: [] };

const employeeWithoutDelete: StaffMembership = {
  role: "employee",
  permissions: ["orders:view"],
};

describe("filterStaffAiTools", () => {
  it("includes exposed staff tools and excludes internal, system, share, and non-staff", () => {
    const filtered = filterStaffAiTools(all, owner);
    expect(filtered).toEqual([staffList, deleteCustomer]);
    expect(filtered).not.toContain(staffInternal);
    expect(filtered).not.toContain(staffHiddenClient);
    expect(filtered).not.toContain(consumerExposed);
    expect(filtered).not.toContain(shareWrite);
    expect(filtered).not.toContain(systemInternal);
  });

  it("lets an owner membership see customers.deleteCustomer via staffHasPermission", () => {
    const names = filterStaffAiTools(all, owner).map(
      (contract) => contract.name,
    );
    expect(names).toContain("customers.deleteCustomer");
  });

  it("hides customers.deleteCustomer from an employee without customers:delete", () => {
    const names = filterStaffAiTools(all, employeeWithoutDelete).map(
      (contract) => contract.name,
    );
    expect(names).toContain("orders.list");
    expect(names).not.toContain("customers.deleteCustomer");
  });
});
