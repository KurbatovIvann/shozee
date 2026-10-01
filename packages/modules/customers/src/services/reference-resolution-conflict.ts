/**
 * Customers-owned structured conflict for CRM reference ambiguity
 * (SHO-410). Duck-types the catalog picker extras so `packages/ai` can
 * map without importing this module. Wire code stays CONFLICT.
 */
import { ConflictError } from "@showzy/core/errors";
import type { EntityLookupTarget } from "@showzy/validation/entity-ref";

export type CustomerReferenceOption = {
  readonly id: string;
  readonly label: string;
};

export class CustomerReferenceConflictError extends ConflictError {
  readonly reason: "ambiguous";
  readonly target: EntityLookupTarget;
  readonly options: readonly CustomerReferenceOption[];
  readonly optionsTruncated: boolean;

  constructor(args: {
    readonly target: EntityLookupTarget;
    readonly options: readonly CustomerReferenceOption[];
    readonly optionsTruncated: boolean;
    readonly clientMessage: string;
  }) {
    super(args.clientMessage);
    this.reason = "ambiguous";
    this.target = args.target;
    this.options = args.options;
    this.optionsTruncated = args.optionsTruncated;
  }
}

export function ambiguousCustomerQueryMessage(query: string): string {
  return `Select a customer matching "${query}".`;
}
