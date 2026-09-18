import { companyCustomers } from "@showzy/db/schema/customers";
import {
  listNameSearch,
  type ListNameSearch,
} from "@showzy/module-kit/name-match";
import { ilike, or } from "drizzle-orm";

export function customerListSearch(query: string): ListNameSearch | undefined {
  return listNameSearch(
    { name: companyCustomers.name, nameFts: companyCustomers.nameFts },
    query,
    (queryNormalized) =>
      or(
        ilike(companyCustomers.phone, `%${queryNormalized}%`),
        ilike(companyCustomers.email, `%${queryNormalized}%`),
      ),
  );
}
