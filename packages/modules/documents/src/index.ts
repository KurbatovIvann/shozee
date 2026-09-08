/**
 * Actions and events only. The `docSigning.recorded` subscriber lives at
 * `./subscriptions` so this barrel can be imported from doc-signing without
 * evaluating `defineEventHandler` (SHO-259; copy doc-generation).
 */
import { attachSignedShare } from "./actions/attach-signed-share.js";
import { cancelDocument } from "./actions/cancel.js";
import { createFromOrder } from "./actions/create-from-order.js";
import { getDocument } from "./actions/get.js";
import { getForGeneration } from "./actions/get-for-generation.js";
import { getShared } from "./actions/get-shared.js";
import { listDocuments } from "./actions/list.js";
import { lockIssuedForSigning } from "./actions/lock-issued-for-signing.js";
import { requestSign } from "./actions/request-sign.js";
import { searchMatches } from "./actions/search-matches.js";
import { shareDocument } from "./actions/share.js";

export { attachSignedShare };
export { cancelDocument };
export { createFromOrder };
export { getDocument };
export { getForGeneration };
export { getShared };
export { listDocuments };
export { lockIssuedForSigning };
export { requestSign };
export { searchMatches };
export { shareDocument };
export { documentsCancelled } from "./events/cancelled.js";
export { documentsCreated } from "./events/created.js";
export { documentsSignRequested } from "./events/sign-requested.js";

export const documentsActions = [
  attachSignedShare,
  cancelDocument,
  createFromOrder,
  getDocument,
  getForGeneration,
  getShared,
  listDocuments,
  lockIssuedForSigning,
  requestSign,
  searchMatches,
  shareDocument,
] as const;
