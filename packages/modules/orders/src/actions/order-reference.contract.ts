import {
  ENTITY_REF_EXACTLY_ONE_MESSAGE,
  entityRefQuerySchema,
  hasExactlyOneReference,
} from "@showzy/validation/entity-ref";
import { z } from "zod";

export const orderReferenceInputSchema = z
  .object({
    orderId: z.uuid().optional(),
    orderNumber: entityRefQuerySchema.optional(),
  })
  .refine(
    (input) =>
      hasExactlyOneReference({ id: input.orderId, query: input.orderNumber }),
    { message: ENTITY_REF_EXACTLY_ONE_MESSAGE },
  );

export type OrderReferenceInput = z.output<typeof orderReferenceInputSchema>;

export const ORDER_REFERENCE_DESCRIPTION =
  "Takes exactly one of a canonical orderId or a human orderNumber (the spoken or printed order number, with or without the company prefix). An exact order number returns that order. Several orders starting with the given number fail with a conflict carrying them as options. No match fails with not-found.";
