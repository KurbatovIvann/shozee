/**
 * The better-auth instance as the transport uses it (`AuthInstance`), built
 * from the two calls it needs.
 *
 * A function rather than an inline object in `boot.ts`, so what it forwards is
 * testable: a session check's `query` must reach better-auth exactly as given.
 * Dropped, an event stream's heartbeat would refresh the session it only meant
 * to read, and watching would keep a session alive (SHO-562).
 */
import type { AuthInstance } from "./app.js";

type SessionArgs = Parameters<AuthInstance["api"]["getSession"]>[0];

export function authInstanceFrom(better: {
  readonly handler: (request: Request) => Promise<Response> | Response;
  readonly getSession: (
    args: SessionArgs,
  ) => Promise<{ readonly user: { readonly id: string } } | null>;
}): AuthInstance {
  return {
    handler: (request) => better.handler(request),
    api: {
      async getSession(args) {
        const result = await better.getSession(args);
        // Identity only: the session row, its token and the user record stay
        // inside better-auth.
        return result === null ? null : { user: { id: result.user.id } };
      },
    },
  };
}
