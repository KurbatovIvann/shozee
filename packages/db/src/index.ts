export {
  assertGrantedTable,
  createProjectionGrantManifest,
  createProjectionReadTx,
  createReadTx,
  defineProjectionGrant,
  ProjectionGrantViolationError,
  projectionGrants,
  type GrantedSelect,
  type ProjectionGrant,
  type ProjectionGrantManifest,
  type ProjectionGrantTable,
  type ProjectionReadTx,
  type ReadTx,
  type Tx,
} from "./capabilities.js";
export {
  createDbClient,
  DEFAULT_POOL_CONNECTION_TIMEOUT_MS,
  DEFAULT_POOL_IDLE_TIMEOUT_MS,
  DEFAULT_POOL_MAX,
  schema,
  type CreateDbClientOptions,
  type Database,
  type DbClient,
  type DbSchema,
} from "./client.js";
export { ownedSchemaModules } from "./schema-modules.js";
export * from "./schema/assistant.js";
export * from "./schema/catalog.js";
export * from "./schema/chat.js";
export * from "./schema/companies.js";
export * from "./schema/customers.js";
export * from "./schema/doc-generation.js";
export * from "./schema/doc-signing.js";
export * from "./schema/documents.js";
export * from "./schema/files.js";
export * from "./schema/foundation.js";
export * from "./schema/invites.js";
export * from "./schema/orders.js";
export * from "./schema/pricing.js";
export {
  nameFtsColumn,
  nameFtsGeneratedSql,
  tsvector,
} from "./schema/tsvector.js";
