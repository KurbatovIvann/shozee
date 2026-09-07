/**
 * Staff customers copy (SHO-476).
 *
 * Wholesale move of the mobile customers tree. Web has no customers
 * copy today — do not invent web strings here. Chrome spreads come
 * from `./chrome`. List vs form trees stay in split files; this is
 * the public subpath barrel.
 */
import {
  en as enClientForm,
  uk as ukClientForm,
  type CustomersFormCopy,
} from "./customers/client-form.js";
import {
  en as enCounterpartyForm,
  uk as ukCounterpartyForm,
  type CustomersCounterpartyFormCopy,
} from "./customers/counterparty-form.js";
import {
  en as enGroupForm,
  uk as ukGroupForm,
  type CustomersGroupFormCopy,
} from "./customers/group-form.js";
import {
  en as enInviteForm,
  uk as ukInviteForm,
  type CustomersInviteFormCopy,
} from "./customers/invite-form.js";
import {
  en as enList,
  uk as ukList,
  type CustomersListCopy,
} from "./customers/list.js";
import { selectCopy, type Locale } from "./locale.js";

export type {
  CustomersConfirmCopy,
  CustomersCountForms,
  CustomersEditorStubCopy,
  CustomersEmptyCopy,
  CustomersInviteStatusCopy,
  CustomersListCopy,
  CustomersMutationCopy,
} from "./customers/list.js";
export type { CustomersFormCopy } from "./customers/client-form.js";
export type { CustomersGroupFormCopy } from "./customers/group-form.js";
export type { CustomersCounterpartyFormCopy } from "./customers/counterparty-form.js";
export type { CustomersInviteFormCopy } from "./customers/invite-form.js";

export type SharedCustomersCopy = CustomersListCopy & {
  readonly form: CustomersFormCopy;
  readonly groupForm: CustomersGroupFormCopy;
  readonly counterpartyForm: CustomersCounterpartyFormCopy;
  readonly inviteForm: CustomersInviteFormCopy;
};

export function sharedCustomersCopy(locale: Locale): SharedCustomersCopy {
  return selectCopy(locale, {
    uk: {
      ...ukList,
      form: ukClientForm,
      groupForm: ukGroupForm,
      counterpartyForm: ukCounterpartyForm,
      inviteForm: ukInviteForm,
    },
    en: {
      ...enList,
      form: enClientForm,
      groupForm: enGroupForm,
      counterpartyForm: enCounterpartyForm,
      inviteForm: enInviteForm,
    },
  });
}
