export const ANNA_ORDER_ID = "11111111-1111-4111-8111-111111111111";
export const DONE_ORDER_ID = "22222222-2222-4222-8222-222222222222";
export const CONFIRMED_ORDER_ID = "33333333-3333-4333-8333-333333333333";
export const IN_PROGRESS_ORDER_ID = "44444444-4444-4444-8444-444444444444";
export const ANNA_CUSTOMER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const ROSE_ITEM_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const ROSE_PRODUCT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const ROSE_FILE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
export const CREATED_ORDER_ID = "99999999-9999-4999-8999-999999999999";
export const CREATED_ORDER_NUMBER = "KL-NEW01";

export const ANNA_ORDER = {
  orderId: ANNA_ORDER_ID,
  orderNumber: "KL-K7K3K4",
  customer: {
    nameSnapshot: "Анна Мельник",
    linkedCustomerId: null,
  },
  status: "new",
  itemCount: 3,
  totalGrossMinor: "150000",
  currency: "UAH",
  createdAt: "2026-03-15T12:00:00.000Z",
} as const;

export const DONE_ORDER = {
  orderId: DONE_ORDER_ID,
  orderNumber: "KL-CLOSED",
  customer: {
    nameSnapshot: "unlinked",
    linkedCustomerId: null,
  },
  status: "done",
  itemCount: 1,
  totalGrossMinor: "50000",
  currency: "UAH",
  createdAt: "2026-01-02T12:00:00.000Z",
} as const;

export const CONFIRMED_ORDER = {
  orderId: CONFIRMED_ORDER_ID,
  orderNumber: "KL-CONF",
  customer: {
    nameSnapshot: "Олена Коваль",
    linkedCustomerId: null,
  },
  status: "confirmed",
  itemCount: 1,
  totalGrossMinor: "150000",
  currency: "UAH",
  createdAt: "2026-03-14T12:00:00.000Z",
} as const;

export const IN_PROGRESS_ORDER = {
  orderId: IN_PROGRESS_ORDER_ID,
  orderNumber: "KL-WORK",
  customer: {
    nameSnapshot: "Ігор Шевченко",
    linkedCustomerId: null,
  },
  status: "in_progress",
  itemCount: 1,
  totalGrossMinor: "150000",
  currency: "UAH",
  createdAt: "2026-03-13T12:00:00.000Z",
} as const;

export const ROSE_LINE = {
  itemId: ROSE_ITEM_ID,
  productId: ROSE_PRODUCT_ID,
  variantId: null,
  titleSnapshot: "Троянди",
  quantityMilli: "3000",
  unitPriceMinor: "50000",
  discountKind: "none",
  discountValue: "0",
  discountAmountMinor: "0",
  taxTreatment: "exempt",
  taxRateBp: 0,
  taxAmountMinor: "0",
  netAmountMinor: "150000",
  grossAmountMinor: "150000",
  currency: "UAH",
  priceSource: "base",
  personalPriceId: null,
  priceListId: null,
  priceListEntryId: null,
  resolverVersion: 1,
} as const;

export const ROSE_PRODUCT = {
  id: ROSE_PRODUCT_ID,
  name: "Троянди",
  basePriceMinor: "50000",
  currency: "UAH",
  status: "active",
  variantCount: 0,
  primaryImageFileId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as const;

export const ROSE_PRODUCT_WITH_IMAGE = {
  ...ROSE_PRODUCT,
  primaryImageFileId: ROSE_FILE_ID,
  imageFileIds: [ROSE_FILE_ID],
} as const;

export const ROSE_THUMB_URL = `https://files.test/${ROSE_FILE_ID}?r=thumb`;

export const ANNA_CUSTOMER = {
  id: ANNA_CUSTOMER_ID,
  name: "Анна Мельник",
  phone: "+380671112233",
  email: null,
  userId: null,
  notes: null,
  groupId: null,
  priceListId: null,
  status: "active",
  linkedCounterpartyCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as const;

export const ANNA_ORDER_DETAIL = {
  orderId: ANNA_ORDER_ID,
  orderNumber: "KL-K7K3K4",
  customerId: ANNA_CUSTOMER_ID,
  customerNameSnapshot: "Анна Мельник",
  status: "new",
  comment: "  Packed separately  ",
  totalNetMinor: "150000",
  totalTaxMinor: "0",
  totalGrossMinor: "150000",
  currency: "UAH",
  confirmedAt: null,
  createdAt: "2026-03-15T12:00:00.000Z",
  items: [ROSE_LINE],
} as const;

export const CONFIRMED_ORDER_DETAIL = {
  orderId: CONFIRMED_ORDER_ID,
  orderNumber: "KL-CONF",
  customerId: null,
  customerNameSnapshot: "Анна Мельник",
  status: "confirmed",
  comment: null,
  totalNetMinor: "150000",
  totalTaxMinor: "0",
  totalGrossMinor: "150000",
  currency: "UAH",
  confirmedAt: "2026-03-14T12:05:00.000Z",
  createdAt: "2026-03-14T12:00:00.000Z",
  items: [ROSE_LINE],
} as const;

export const IN_PROGRESS_ORDER_DETAIL = {
  orderId: IN_PROGRESS_ORDER_ID,
  orderNumber: "KL-WORK",
  customerId: null,
  customerNameSnapshot: "Анна Мельник",
  status: "in_progress",
  comment: null,
  totalNetMinor: "150000",
  totalTaxMinor: "0",
  totalGrossMinor: "150000",
  currency: "UAH",
  confirmedAt: "2026-03-13T12:05:00.000Z",
  createdAt: "2026-03-13T12:00:00.000Z",
  items: [ROSE_LINE],
} as const;

export const DONE_ORDER_DETAIL = {
  orderId: DONE_ORDER_ID,
  orderNumber: "KL-CLOSED",
  customerId: null,
  customerNameSnapshot: "Анна Мельник",
  status: "done",
  comment: null,
  totalNetMinor: "50000",
  totalTaxMinor: "0",
  totalGrossMinor: "50000",
  currency: "UAH",
  confirmedAt: "2026-01-02T12:05:00.000Z",
  createdAt: "2026-01-02T12:00:00.000Z",
  items: [
    {
      ...ROSE_LINE,
      netAmountMinor: "50000",
      grossAmountMinor: "50000",
      quantityMilli: "1000",
    },
  ],
} as const;
