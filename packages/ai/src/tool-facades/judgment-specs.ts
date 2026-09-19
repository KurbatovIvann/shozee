export const JUDGMENT_NONE = "none";

export const JUDGMENT_SPAN_SLOTS = {
  customerName:
    "the name of the customer the message is about, exactly as written, without surrounding words",
  groupName: "the name of the customer group, without the word for group",
  productName:
    "the name of the product being added, re-priced or searched for, without its price",
  priceListName: "the name of the price list, without the word for price list",
} as const;

export const JUDGMENT_NUMBER_SLOTS = {
  customerPhone: "the customer's phone number",
  price: "the price of the product being added",
} as const;

export const JUDGMENT_CLOSED_SLOTS = {
  period: {
    instructions: "Which period of orders does `message` ask about?",
    criteria: {
      today: "Today.",
      this_week: "The current week.",
      this_month: "The current month.",
      other_period: "Another period, such as yesterday or last month.",
      none: "No period is stated.",
    },
  },
  orderStatus: {
    instructions: "Which order status does `message` restrict the orders to?",
    criteria: {
      new: "New, not yet confirmed.",
      confirmed: "Confirmed.",
      in_progress: "In progress.",
      done: "Completed.",
      canceled: "Cancelled.",
      none: "No status is stated.",
    },
  },
} as const;

export type JudgmentSpanSlot = keyof typeof JUDGMENT_SPAN_SLOTS;
export type JudgmentNumberSlot = keyof typeof JUDGMENT_NUMBER_SLOTS;
export type JudgmentClosedSlot = keyof typeof JUDGMENT_CLOSED_SLOTS;
export type JudgmentSlot =
  JudgmentSpanSlot | JudgmentNumberSlot | JudgmentClosedSlot;

export type JudgmentArgShape = "text" | "list" | "minorUnits";

export interface JudgmentArgSpec {
  readonly slot: JudgmentSlot;
  readonly shape: JudgmentArgShape;
  readonly unsupported?: readonly string[];
}

export interface StaffJudgmentSpec {
  readonly tool: string;
  readonly action: string;
  readonly job: { readonly yes: string; readonly no: string };
  readonly args: Readonly<Record<string, JudgmentArgSpec>>;
  readonly carries: string;
  readonly beyond: string;
  readonly reply?: { readonly uk: string; readonly en: string };
  readonly required?: readonly string[];
  readonly thresholds?: {
    readonly take?: number;
    readonly act?: number;
    readonly argument?: number;
  };
  readonly items?: {
    readonly arg: string;
    readonly product: string;
    readonly quantity: string;
    readonly quantityMilli: string;
  };
}

const text = (slot: JudgmentSlot): JudgmentArgSpec => ({
  slot,
  shape: "text",
});

const orderFilterLimits = {
  carries: "one period (today, this week or this month) and one order status",
  beyond:
    "a customer, a product, an amount, a date or another period, a second status, a sort order, or how many to show",
} as const;

const orderFilters = {
  period: { slot: "period", shape: "text", unsupported: ["other_period"] },
  statuses: { slot: "orderStatus", shape: "list" },
} as const satisfies Record<string, JudgmentArgSpec>;

export const STAFF_JUDGMENT_SPECS: readonly StaffJudgmentSpec[] = [
  {
    tool: "orders_list_counts",
    action: "orders.list",
    job: {
      yes: "count orders or report turnover (скільки, оборот)",
      no: "It asks to show the orders themselves, or asks nothing about order totals.",
    },
    args: orderFilters,
    ...orderFilterLimits,
    reply: {
      uk: "Ось підсумок за замовленнями.",
      en: "Here is the orders summary.",
    },
  },
  {
    tool: "orders_list_page",
    action: "orders.list",
    job: {
      yes: "show a list of orders (покажи замовлення)",
      no: "It asks for a number or a total, or for one specific order action.",
    },
    args: orderFilters,
    ...orderFilterLimits,
    reply: {
      uk: "Ось замовлення за вашим запитом.",
      en: "Here are the orders you asked for.",
    },
  },
  {
    tool: "customers_list_customers",
    action: "customers.listCustomers",
    job: {
      yes: "find or show existing customers",
      no: "The customer is only named as part of another job, or a new customer is being added, or it asks about customer groups or about counterparties.",
    },
    args: { search: text("customerName") },
    carries: "a customer name to search by",
    beyond:
      "a phone, an email, a group, a status, a date, or another condition",
  },
  {
    tool: "customers_list_groups",
    action: "customers.listGroups",
    job: {
      yes: "show or find customer groups",
      no: "A group is only named as part of another job, or a new group is being created.",
    },
    args: { search: text("groupName") },
    carries: "a group name to search by",
    beyond: "its members, a price list, a discount, or another condition",
  },
  {
    tool: "catalog_list_products",
    action: "catalog.listProducts",
    job: {
      yes: "show or find products in the catalog",
      no: "A product is only named as part of an order, or a new product is being added, or it asks about price lists (прайс, прайс-лист) rather than products.",
    },
    args: { query: text("productName") },
    carries: "a product name to search by",
    beyond:
      "a price, a status such as archived, a category, stock, or another condition",
  },
  {
    tool: "pricing_list_price_lists",
    action: "pricing.listPriceLists",
    job: {
      yes: "show or find price lists",
      no: "A price list is only being created or changed.",
    },
    args: { query: text("priceListName") },
    carries: "a price list name to search by",
    beyond: "a status such as active, a date, a currency, or another condition",
  },
  {
    tool: "orders_create",
    action: "orders.create",
    job: {
      yes: "create a new order with products for a customer",
      no: "It only refers to an existing order: confirming, cancelling, starting, completing, listing, counting, or issuing a document for it.",
    },
    args: { customerQuery: text("customerName") },
    carries: "who the customer is, which products and how many of each",
    beyond:
      "a date or time, delivery or pickup, an address, a comment or note, a price, a discount, or a payment",
    required: ["customerQuery", "items"],
    thresholds: { act: 0.75 },
    reply: { uk: "Створив замовлення.", en: "The order is created." },
    items: {
      arg: "items",
      product: "productQuery",
      quantity: "quantityDecimal",
      quantityMilli: "quantityMilli",
    },
  },
  {
    tool: "customers_createCustomer",
    action: "customers.createCustomer",
    job: {
      yes: "register a new customer record for a person or company that is not in the customer base yet",
      no: "It only refers to an existing customer: ordering for them, finding them, or putting them into a group.",
    },
    args: { name: text("customerName"), phone: text("customerPhone") },
    required: ["name"],
    carries: "the new customer's name and phone",
    beyond:
      "an email, an address, a note, a group, a price list, a discount, or a second thing to do",
  },
  {
    tool: "customers_createGroup",
    action: "customers.createGroup",
    job: {
      yes: "create a new customer group",
      no: "It only mentions an existing group, for example to put a customer into it.",
    },
    args: { name: text("groupName") },
    required: ["name"],
    carries: "the new group's name",
    beyond:
      "customers to put into it, a price list, a discount, a description, or a second thing to do",
  },
  {
    tool: "catalog_createProduct",
    action: "catalog.createProduct",
    job: {
      yes: "add a new product to the catalog",
      no: "It only orders, finds or re-prices a product that already exists.",
    },
    args: {
      name: text("productName"),
      basePriceMinor: { slot: "price", shape: "minorUnits" },
    },
    required: ["name"],
    carries: "the new product's name and price",
    beyond:
      "variants or sizes, a unit of measure, a description, a category, a photo, stock, or a second thing to do",
  },
  {
    tool: "pricing_createPriceList",
    action: "pricing.createPriceList",
    job: {
      yes: "create a new price list (прайс, прайс-лист)",
      no: "It only mentions or asks about existing price lists.",
    },
    args: { name: text("priceListName") },
    required: ["name"],
    carries: "the new price list's name",
    beyond:
      "a currency, dates, prices or products to put into it, copying another price list, or making it default or active",
  },
];
