/**
 * What kinds of interaction exist is the caller's decision, not this
 * package's.
 *
 * A previous shape enumerated two kinds and their answers. That is a product
 * vocabulary wearing a library's clothes: a third kind meant editing the
 * library. Here the set of kinds is the set of keys the caller registers, so
 * the union is derived rather than declared — a mistyped kind is a type error,
 * exactly as an enum would give, but the enum belongs to the consumer.
 */
import type { z } from "zod";

/**
 * What a claimed answer amounts to.
 *
 * `unresolvable` is refused **before** the claim is consumed, so an answer
 * that cannot mean anything — an option the interaction never offered — does
 * not burn the one claim the pause has.
 */
export type Resolution =
  | { readonly kind: "resolved"; readonly value: unknown }
  | { readonly kind: "unresolvable"; readonly reason: string };

export function resolved(value: unknown): Resolution {
  return { kind: "resolved", value };
}

export function unresolvable(reason: string): Resolution {
  return { kind: "unresolvable", reason };
}

export interface InteractionSpec<
  TPrompt extends z.ZodType,
  TAnswer extends z.ZodType,
  TSecret,
> {
  /** How long this kind of question may wait. "Which one" and "are you sure"
   * tolerate interruption differently; that is a property of the kind. */
  readonly ttlMs: number;
  /** The payload a client may see. Validated when the pause opens. */
  readonly prompt: TPrompt;
  /** What a client may send back. Validated per kind, not as one wide union. */
  readonly answer: TAnswer;
  /**
   * Bridge the answer and the private data the pause kept. Pure: it decides
   * meaning, it does not perform effects. The caller acts on `value` after the
   * claim succeeds.
   */
  readonly resolve: (input: {
    readonly answer: z.output<TAnswer>;
    readonly secret: TSecret;
  }) => Resolution;
}

export interface InteractionType<
  TPrompt extends z.ZodType = z.ZodType,
  TAnswer extends z.ZodType = z.ZodType,
  TSecret = unknown,
> extends InteractionSpec<TPrompt, TAnswer, TSecret> {
  readonly __brand: "interaction";
}

/**
 * Curried so the private payload type is stated once and explicitly, while the
 * two schemas still infer:
 *
 * ```ts
 * defineInteraction<MySecret>()({ ttlMs, prompt, answer, resolve })
 * ```
 */
export function defineInteraction<TSecret = unknown>() {
  return <TPrompt extends z.ZodType, TAnswer extends z.ZodType>(
    spec: InteractionSpec<TPrompt, TAnswer, TSecret>,
  ): InteractionType<TPrompt, TAnswer, TSecret> => ({
    ...spec,
    __brand: "interaction",
  });
}

/** Any registered kind, once its type parameters stop mattering. */
export type AnyInteraction = InteractionType<z.ZodType, z.ZodType, never>;

export interface InteractionRegistry<
  T extends Record<string, InteractionType<z.ZodType, z.ZodType, never>>,
> {
  /** The registered kinds. `kinds[number]` is the derived union. */
  readonly kinds: readonly (keyof T & string)[];
  /**
   * Look up an untrusted kind. `undefined` covers both a typo and a pause
   * that outlived the deploy which removed its kind; the caller treats the
   * second the same as a pause that is gone.
   */
  get(kind: string): AnyInteraction | undefined;
  has(kind: string): kind is keyof T & string;
}

export function createInteractions<
  T extends Record<string, InteractionType<z.ZodType, z.ZodType, never>>,
>(types: T): InteractionRegistry<T> {
  const kinds = Object.keys(types) as (keyof T & string)[];
  return {
    kinds,
    get: (kind) => types[kind],
    has: (kind): kind is keyof T & string =>
      Object.prototype.hasOwnProperty.call(types, kind),
  };
}

/** The kinds a registry accepts, as a union. */
export type KindOf<R> =
  R extends InteractionRegistry<infer T> ? keyof T & string : never;
