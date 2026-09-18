import { companyCustomers } from "@showzy/db/schema/customers";
import {
  listNameSearch,
  referenceNameSearch,
  type ListNameSearch,
} from "@showzy/module-kit/name-match";
import { ilike, or } from "drizzle-orm";

const nameColumns = {
  name: companyCustomers.name,
  nameFts: companyCustomers.nameFts,
};

const contactContains = (queryNormalized: string) =>
  or(
    ilike(companyCustomers.phone, `%${queryNormalized}%`),
    ilike(companyCustomers.email, `%${queryNormalized}%`),
  );

export function customerListSearch(query: string): ListNameSearch | undefined {
  return listNameSearch(nameColumns, query, contactContains);
}

export function customerReferenceSearch(
  query: string,
): ListNameSearch | undefined {
  return referenceNameSearch(nameColumns, query, contactContains);
}
