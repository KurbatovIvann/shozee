/**
 * The client-exposure composition record (contract.md §2, layer 2).
 *
 * `packages/contract` imports **only** module `index.contract.ts` barrels;
 * each module task adds its client-routable descriptors here, keyed
 * `<module>.<verb>` exactly like the descriptor names. Internal facts
 * actions stay off this record — only `transport: "client"` descriptors
 * are routable.
 *
 * The server-router builder (./server) proves in both directions that
 * this record matches the boot registry: a registered client action
 * missing here, or an entry here that is not registered, fails boot.
 */
import {
  createConversationContract,
  listConversationsContract,
} from "@showzy/assistant/contract";
import {
  archiveProductContract,
  archiveVariantContract,
  createProductContract,
  createVariantContract,
  getProductContract,
  listProductsContract,
  restoreProductContract,
  restoreVariantContract,
  setProductImagesContract,
  updateProductContract,
  updateVariantContract,
} from "@showzy/catalog/contract";
import { getOrderCardContract } from "@showzy/chat/contract";
import {
  createCompanyContract,
  getCompanyContract,
  listMineContract,
  updateLegalContract,
} from "@showzy/companies/contract";
import {
  archiveCustomerContract,
  createCounterpartyContract,
  createCustomerContract,
  createGroupContract,
  deleteCounterpartyContract,
  deleteCustomerContract,
  deleteGroupContract,
  getCounterpartyContract,
  getCustomerContract,
  getGroupContract,
  listCounterpartiesContract,
  listCustomersContract,
  listGroupsContract,
  restoreCustomerContract,
  updateCounterpartyContract,
  updateCustomerContract,
  updateGroupContract,
} from "@showzy/customers/contract";
import {
  cancelDocumentContract,
  createFromOrderContract,
  getDocumentContract,
  getSharedContract,
  listDocumentsContract,
  requestSignContract,
  shareDocumentContract,
} from "@showzy/documents/contract";
import { listLayoutsContract } from "@showzy/doc-generation/contract";
import {
  completeSigningContract,
  getSigningContract,
  startSigningContract,
} from "@showzy/doc-signing/contract";
import {
  finalizeUploadContract,
  getDownloadUrlContract,
  getDownloadUrlsContract,
  getSigningUploadUrlContract,
  getUploadUrlContract,
  requestSigningUploadContract,
  requestUploadContract,
} from "@showzy/files/contract";
import {
  acceptInviteContract,
  createInviteContract,
  getInviteContract,
  listInvitesContract,
  revokeInviteContract,
} from "@showzy/invites/contract";
import {
  cancelOrderContract,
  completeOrderContract,
  confirmOrderContract,
  createOrderContract,
  getOrderContract,
  listOrdersContract,
  startOrderContract,
} from "@showzy/orders/contract";
import {
  activatePriceListContract,
  createPriceListContract,
  deactivatePriceListContract,
  deletePriceListContract,
  getPriceListContract,
  listPriceListEntriesContract,
  listPriceListsContract,
  removePriceListEntriesContract,
  setDefaultPriceListContract,
  setPriceListEntriesContract,
  updatePriceListContract,
} from "@showzy/pricing/contract";
import { queryContract } from "@showzy/search/contract";

import {
  buildContractRouter,
  type ContractModuleMap,
} from "./contract-router.js";

export const contractModules = {
  assistant: {
    createConversation: createConversationContract,
    listConversations: listConversationsContract,
  },
  catalog: {
    createProduct: createProductContract,
    createVariant: createVariantContract,
    getProduct: getProductContract,
    listProducts: listProductsContract,
    updateProduct: updateProductContract,
    updateVariant: updateVariantContract,
    archiveProduct: archiveProductContract,
    restoreProduct: restoreProductContract,
    archiveVariant: archiveVariantContract,
    restoreVariant: restoreVariantContract,
    setProductImages: setProductImagesContract,
  },
  chat: {
    getOrderCard: getOrderCardContract,
  },
  companies: {
    create: createCompanyContract,
    get: getCompanyContract,
    listMine: listMineContract,
    updateLegal: updateLegalContract,
  },
  customers: {
    archiveCustomer: archiveCustomerContract,
    createCounterparty: createCounterpartyContract,
    createCustomer: createCustomerContract,
    createGroup: createGroupContract,
    deleteCounterparty: deleteCounterpartyContract,
    deleteCustomer: deleteCustomerContract,
    deleteGroup: deleteGroupContract,
    getCounterparty: getCounterpartyContract,
    getCustomer: getCustomerContract,
    getGroup: getGroupContract,
    listCounterparties: listCounterpartiesContract,
    listCustomers: listCustomersContract,
    listGroups: listGroupsContract,
    restoreCustomer: restoreCustomerContract,
    updateCounterparty: updateCounterpartyContract,
    updateCustomer: updateCustomerContract,
    updateGroup: updateGroupContract,
  },
  documents: {
    cancel: cancelDocumentContract,
    createFromOrder: createFromOrderContract,
    get: getDocumentContract,
    getShared: getSharedContract,
    list: listDocumentsContract,
    requestSign: requestSignContract,
    share: shareDocumentContract,
  },
  docGeneration: {
    listLayouts: listLayoutsContract,
  },
  docSigning: {
    complete: completeSigningContract,
    get: getSigningContract,
    start: startSigningContract,
  },
  files: {
    requestUpload: requestUploadContract,
    getUploadUrl: getUploadUrlContract,
    finalizeUpload: finalizeUploadContract,
    getDownloadUrl: getDownloadUrlContract,
    getDownloadUrls: getDownloadUrlsContract,
    requestSigningUpload: requestSigningUploadContract,
    getSigningUploadUrl: getSigningUploadUrlContract,
  },
  invites: {
    accept: acceptInviteContract,
    create: createInviteContract,
    get: getInviteContract,
    list: listInvitesContract,
    revoke: revokeInviteContract,
  },
  orders: {
    create: createOrderContract,
    confirm: confirmOrderContract,
    start: startOrderContract,
    complete: completeOrderContract,
    cancel: cancelOrderContract,
    get: getOrderContract,
    list: listOrdersContract,
  },
  pricing: {
    activatePriceList: activatePriceListContract,
    createPriceList: createPriceListContract,
    deactivatePriceList: deactivatePriceListContract,
    deletePriceList: deletePriceListContract,
    getPriceList: getPriceListContract,
    listPriceListEntries: listPriceListEntriesContract,
    listPriceLists: listPriceListsContract,
    removePriceListEntries: removePriceListEntriesContract,
    setDefaultPriceList: setDefaultPriceListContract,
    setPriceListEntries: setPriceListEntriesContract,
    updatePriceList: updatePriceListContract,
  },
  search: {
    query: queryContract,
  },
} satisfies ContractModuleMap;

/**
 * The oRPC contract router — what the typed client and the OpenAPI
 * document (fnd-T25) consume.
 */
export const contractRouter = buildContractRouter(contractModules);
