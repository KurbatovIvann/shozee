export interface DbHarnessContext {
  readonly adminUrl: string;
  readonly templateDatabase: string;
  readonly runtimeRole: string;
  readonly runtimePassword: string;
  readonly reaperSessionId: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    dbHarness: DbHarnessContext;
  }
}
