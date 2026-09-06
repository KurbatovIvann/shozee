/**
 * Domain schema namespaces keyed by the action-module prefix (`moduleOf`).
 * Foundation and auth stay outside this map (platform tables, not
 * `<module>.<verb>` owners). Adding a module schema file here is what
 * lets SHO-467 resolve that module's tables — keep in lockstep with
 * `client.ts` `schema`.
 */
import * as assistant from "./schema/assistant.js";
import * as catalog from "./schema/catalog.js";
import * as chat from "./schema/chat.js";
import * as companies from "./schema/companies.js";
import * as customers from "./schema/customers.js";
import * as docGeneration from "./schema/doc-generation.js";
import * as docSigning from "./schema/doc-signing.js";
import * as documents from "./schema/documents.js";
import * as files from "./schema/files.js";
import * as invites from "./schema/invites.js";
import * as orders from "./schema/orders.js";
import * as pricing from "./schema/pricing.js";

export const ownedSchemaModules = {
  assistant,
  catalog,
  chat,
  companies,
  customers,
  docGeneration,
  docSigning,
  documents,
  files,
  invites,
  orders,
  pricing,
} as const;
