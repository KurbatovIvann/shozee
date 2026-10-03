import {
  ENTITY_REF_EXACTLY_ONE_MESSAGE,
  entityRefQuerySchema,
  hasExactlyOneReference,
} from "@showzy/validation/entity-ref";
import { z } from "zod";

export const documentReferenceInputSchema = z
  .strictObject({
    documentId: z.uuid().optional(),
    documentNumber: entityRefQuerySchema.optional(),
  })
  .refine(
    (input) =>
      hasExactlyOneReference({
        id: input.documentId,
        query: input.documentNumber,
      }),
    { message: ENTITY_REF_EXACTLY_ONE_MESSAGE },
  );

export type DocumentReferenceInput = z.output<
  typeof documentReferenceInputSchema
>;

export const DOCUMENT_REFERENCE_DESCRIPTION =
  "Takes exactly one of a canonical documentId or a human documentNumber (the spoken or printed document number: the full code with or without the company prefix, or the bare sequence, which names the invoice and the delivery note alike). An exact document number returns that document. Several documents starting with the given number fail with a conflict carrying them as options. No match fails with not-found.";
