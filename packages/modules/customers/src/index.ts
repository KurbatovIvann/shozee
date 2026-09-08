import { applyInviteCrm } from "./actions/apply-invite-crm.js";
import { archiveCustomer } from "./actions/archive-customer.js";
import { createCounterparty } from "./actions/create-counterparty.js";
import { createCustomer } from "./actions/create-customer.js";
import { createGroup } from "./actions/create-group.js";
import { deleteCounterparty } from "./actions/delete-counterparty.js";
import { deleteCustomer } from "./actions/delete-customer.js";
import { deleteGroup } from "./actions/delete-group.js";
import { getCounterparty } from "./actions/get-counterparty.js";
import { getCustomer } from "./actions/get-customer.js";
import { getCustomerPricingFacts } from "./actions/get-customer-pricing-facts.js";
import { getGroup } from "./actions/get-group.js";
import { listCounterparties } from "./actions/list-counterparties.js";
import { listCustomers } from "./actions/list-customers.js";
import { listGroups } from "./actions/list-groups.js";
import { listMatchingIds } from "./actions/list-matching-ids.js";
import { resolveCustomerReference } from "./actions/resolve-customer-reference.js";
import { restoreCustomer } from "./actions/restore-customer.js";
import { searchMatches } from "./actions/search-matches.js";
import { updateCounterparty } from "./actions/update-counterparty.js";
import { updateCustomer } from "./actions/update-customer.js";
import { updateGroup } from "./actions/update-group.js";
import { CustomerReferenceConflictError } from "./services/reference-resolution-conflict.js";

export { applyInviteCrm };
export { archiveCustomer };
export { createCounterparty };
export { createCustomer };
export { createGroup };
export { deleteCounterparty };
export { deleteCustomer };
export { deleteGroup };
export { getCounterparty };
export { getCustomer };
export { getCustomerPricingFacts };
export { getGroup };
export { listCounterparties };
export { listCustomers };
export { listGroups };
export { listMatchingIds };
export { resolveCustomerReference };
export { restoreCustomer };
export { searchMatches };
export { updateCounterparty };
export { updateCustomer };
export { updateGroup };
export { CustomerReferenceConflictError };

export const customersActions = [
  applyInviteCrm,
  archiveCustomer,
  createCounterparty,
  createCustomer,
  createGroup,
  deleteCounterparty,
  deleteCustomer,
  deleteGroup,
  getCounterparty,
  getCustomer,
  getCustomerPricingFacts,
  getGroup,
  listCounterparties,
  listCustomers,
  listGroups,
  listMatchingIds,
  resolveCustomerReference,
  restoreCustomer,
  searchMatches,
  updateCounterparty,
  updateCustomer,
  updateGroup,
] as const;
