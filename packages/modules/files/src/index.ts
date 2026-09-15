import { backfillCatalogRenditions } from "./actions/backfill-catalog-renditions.js";
import { finalizeUpload } from "./actions/finalize-upload.js";
import { getAttachmentFacts } from "./actions/get-attachment-facts.js";
import { getDownloadUrl } from "./actions/get-download-url.js";
import { getDownloadUrls } from "./actions/get-download-urls.js";
import { getSigningUploadUrl } from "./actions/get-signing-upload-url.js";
import { getUploadUrl } from "./actions/get-upload-url.js";
import { issueDocumentDownloadUrl } from "./actions/issue-document-download-url.js";
import { issueShareDownloadUrl } from "./actions/issue-share-download-url.js";
import { issueShareSigningDownloadUrl } from "./actions/issue-share-signing-download-url.js";
import { issueSigningDownloadUrl } from "./actions/issue-signing-download-url.js";
import { issueSystemSigningDownloadUrl } from "./actions/issue-system-signing-download-url.js";
import { readPendingSigningObject } from "./actions/read-pending-signing-object.js";
import { recordGeneratedObject } from "./actions/record-generated-object.js";
import { recordSigningObject } from "./actions/record-signing-object.js";
import { requestSigningUpload } from "./actions/request-signing-upload.js";
import { requestUpload } from "./actions/request-upload.js";
import { sweepAbandonedUploads } from "./actions/sweep-abandoned-uploads.js";
import {
  backfillCatalogRenditionsJob,
  sweepAbandonedUploadsJob,
} from "./jobs/maintenance-jobs.js";

export { backfillCatalogRenditionsJob, sweepAbandonedUploadsJob };

export const filesJobs = [
  sweepAbandonedUploadsJob,
  backfillCatalogRenditionsJob,
] as const;

export { backfillCatalogRenditions };
export { finalizeUpload };
export { getAttachmentFacts };
export { getDownloadUrl };
export { getDownloadUrls };
export { getSigningUploadUrl };
export { getUploadUrl };
export { issueDocumentDownloadUrl };
export { issueShareDownloadUrl };
export { issueShareSigningDownloadUrl };
export { issueSigningDownloadUrl };
export { issueSystemSigningDownloadUrl };
export { readPendingSigningObject };
export { recordGeneratedObject };
export { recordSigningObject };
export { requestSigningUpload };
export { requestUpload };
export { sweepAbandonedUploads };

export const filesActions = [
  requestUpload,
  getUploadUrl,
  finalizeUpload,
  getDownloadUrl,
  getDownloadUrls,
  getAttachmentFacts,
  issueDocumentDownloadUrl,
  issueShareDownloadUrl,
  recordGeneratedObject,
  requestSigningUpload,
  getSigningUploadUrl,
  recordSigningObject,
  readPendingSigningObject,
  issueSigningDownloadUrl,
  issueShareSigningDownloadUrl,
  issueSystemSigningDownloadUrl,
  sweepAbandonedUploads,
  backfillCatalogRenditions,
] as const;
