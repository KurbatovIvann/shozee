import { implementAction } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import { getAttachmentFacts } from "@showzy/files";

import { rejectNonImageAttachments } from "../services/image-mime.js";
import { productAuditTarget } from "../services/product-audit-target.js";
import { replaceProductImages } from "../services/set-product-images.js";
import { setProductImagesContract } from "./set-product-images.contract.js";

function provenAttachmentFileIds(
  requested: readonly string[],
  facts: readonly { readonly fileId: string }[],
): string[] {
  if (facts.length !== requested.length) {
    throw new CoreInvariantError(
      "attachment facts count drifted from unique input",
    );
  }
  const proven = new Map(facts.map((file) => [file.fileId, file.fileId]));
  if (proven.size !== facts.length) {
    throw new CoreInvariantError("attachment facts included a duplicate file");
  }
  return requested.map((fileId) => {
    const id = proven.get(fileId);
    if (id === undefined) {
      throw new CoreInvariantError("attachment facts omitted a requested file");
    }
    return id;
  });
}

export const setProductImages = implementAction(setProductImagesContract, {
  handler: async (input, ctx) => {
    // Empty list clears media; facts require min 1 id.
    if (input.fileIds.length === 0) {
      return replaceProductImages({
        ctx,
        productId: input.productId,
        fileIds: [],
      });
    }

    const facts = await ctx.call(getAttachmentFacts, {
      fileIds: input.fileIds,
    });
    const fileIds = provenAttachmentFileIds(input.fileIds, facts.files);
    rejectNonImageAttachments(facts.files);

    return replaceProductImages({
      ctx,
      productId: input.productId,
      fileIds,
    });
  },
  auditTarget: productAuditTarget,
});
