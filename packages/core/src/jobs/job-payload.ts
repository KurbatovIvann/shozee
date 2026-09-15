import { z } from "zod";

declare const jobFieldBrand: unique symbol;

export type JobField<TSchema extends z.ZodType = z.ZodType> = TSchema & {
  readonly [jobFieldBrand]: true;
};

export type JobPayloadShape = Readonly<Record<string, JobField>>;

export interface JobIntegerBounds {
  readonly min?: number;
  readonly max?: number;
}

const coreFields = new WeakSet<z.ZodType>();
const corePayloads = new WeakSet<z.ZodType>();

function field<TSchema extends z.ZodType>(
  schema: TSchema,
  jsonSafe: boolean,
): JobField<TSchema> {
  if (jsonSafe) {
    coreFields.add(schema);
  }
  return schema as JobField<TSchema>;
}

function isOptionalSafeInteger(value: number | undefined): boolean {
  return value === undefined || Number.isSafeInteger(value);
}

function integer(bounds: JobIntegerBounds = {}): JobField<z.ZodInt> {
  const { min, max } = bounds;
  let schema = z.int();
  if (min !== undefined) {
    schema = schema.min(min);
  }
  if (max !== undefined) {
    schema = schema.max(max);
  }
  return field(
    schema,
    isOptionalSafeInteger(min) && isOptionalSafeInteger(max),
  );
}

export const jobField = Object.freeze({
  uuid: (): JobField<z.ZodUUID> => field(z.uuid(), true),
  enum: <const TValues extends readonly [string, ...string[]]>(
    values: TValues,
  ): JobField<z.ZodEnum<{ [K in TValues[number]]: K }>> =>
    field(
      z.enum(values),
      values.every((value) => typeof value === "string"),
    ),
  literal: <const TValue extends string>(
    value: TValue,
  ): JobField<z.ZodLiteral<TValue>> =>
    field(z.literal(value), typeof value === "string"),
  integer,
});

export function jobPayload<const TShape extends JobPayloadShape>(
  shape: TShape,
): z.ZodObject<{ -readonly [K in keyof TShape]: TShape[K] }, z.core.$strict> {
  const payload = z.strictObject({ ...shape });
  corePayloads.add(payload);
  return payload;
}

export function isCoreJobPayload(schema: unknown): boolean {
  return schema instanceof z.ZodType && corePayloads.has(schema);
}

export function isCoreJobField(schema: unknown): boolean {
  return schema instanceof z.ZodType && coreFields.has(schema);
}
