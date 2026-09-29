// D82: «на нього» / «на ньому» and the recogniser's bare «ньому» for «на нього» («підтвердь замовлення 198 і виставку ньому рахунок»), ru «на него».
export const REF_PHRASES: readonly string[] = [
  "для нього", "для неї", "по ньому", "по ній", "цьому клієнту", "цій клієнтці", "на нього", "на ньому",
  "для него", "для нее", "по нему", "по ней", "этому клиенту", "этой клиентке", "на него",
  "йому", "їй", "йой", "їм", "його", "її", "ему", "ей", "им", "его", "ее", "её", "ньому",
].toSorted((left, right) => right.split(" ").length - left.split(" ").length);

export const ORDER_REFS: ReadonlySet<string> = new Set(["по ньому", "по нему", "його", "его", "на нього", "на ньому", "ньому", "на него"]);

export const REF_FRAME_WORDS: ReadonlySet<string> = new Set(["для", "по", "на", "цьому", "цій", "клієнту", "клієнтці", "этому", "этой", "клиенту", "клиентке"]);

// D82 (E9): words that point back at a price list the command before named («… у прайсі гуртовий, прибери з нього круасан»): the command takes it
// (`references.ts` `priceListReference`).
export const PRICE_LIST_REFS: readonly string[] = ["з нього", "із нього", "зі нього", "в ньому", "у ньому", "в нього", "до нього", "звідти", "туди", "з него", "из него", "в нем", "в него", "оттуда", "туда"];

export const PRONOUNS: ReadonlySet<string> = new Set(REF_PHRASES.flatMap((phrase) => phrase.split(" ")).filter((word) => !REF_FRAME_WORDS.has(word)));

export type RecordReference = readonly [param: string, phrases: readonly string[]];

export const RECORD_REFS: ReadonlyMap<string, RecordReference> = new Map<string, RecordReference>([
  ["orders.create", ["order_number", ["це замовлення", "цього замовлення", "цим замовленням", "по ньому", "його", "этот заказ", "этого заказа", "по нему", "его"]]],
  ["documents.createFromOrder", ["document_ref", ["цей документ", "цю накладну", "цей рахунок", "її", "його", "этот документ", "эту накладную", "этот счет", "ее", "её", "его"]]],
  ["customers.createGroup", ["group", ["туди", "в неї", "до неї", "в цю групу", "у цю групу", "до цієї групи", "туда", "в нее", "в эту группу"]]],
  // v3 (D70): the waybill or the receipt just made («створи ТТН … і скинь її номер», «пробий чек … і скинь його клієнтці»).
  ["delivery.createShipment", ["ttn", ["цю ттн", "ця ттн", "цієї ттн", "її", "ее", "её", "эту ттн"]]],
  ["fiscal.createReceipt", ["document_ref", ["цей чек", "цього чека", "цього чеку", "його", "этот чек", "его"]]],
]);

// D70 (intents v3 §6d): words that point at a record the person sees or has just dealt with, not at one they name. The model tags no span on them;
// in a v3 bundle the runtime gives the param they point at a `Ref {status: "context"}` (the host fills it from the record on screen or its last
// result) unless an earlier command of the same utterance made it (`refPrevious`). The target is a param type: `customer` is the intent's customer
// param. Bare «його» / «її» / «его» / «ее» stay out: they are an order, a receipt or a person by the sentence, which D27 decides after an earlier
// command.
export type DeicticTarget = "customer" | "order_number" | "ttn" | "product" | "document_ref";
export const DEICTICS: readonly (readonly [phrase: string, target: DeicticTarget])[] = [
  ["їй", "customer"], ["йому", "customer"], ["їм", "customer"], ["ей", "customer"], ["ему", "customer"],
  ["цьому клієнту", "customer"], ["цій клієнтці", "customer"], ["цього клієнта", "customer"], ["цієї клієнтки", "customer"], ["цим клієнтом", "customer"],
  ["клієнту", "customer"], ["клієнтці", "customer"], ["этому клиенту", "customer"], ["этой клиентке", "customer"], ["этого клиента", "customer"],
  ["этой клиентки", "customer"], ["клиенту", "customer"], ["клиентке", "customer"],
  ["це замовлення", "order_number"], ["цього замовлення", "order_number"], ["цьому замовленню", "order_number"], ["цьому замовленні", "order_number"],
  ["цим замовленням", "order_number"], ["этот заказ", "order_number"], ["этого заказа", "order_number"], ["этому заказу", "order_number"], ["этом заказе", "order_number"],
  ["цю ттн", "ttn"], ["ця ттн", "ttn"], ["цієї ттн", "ttn"], ["цій ттн", "ttn"], ["цю посилку", "ttn"], ["ця посилка", "ttn"], ["цієї посилки", "ttn"],
  ["эту ттн", "ttn"], ["эта ттн", "ttn"], ["этой ттн", "ttn"], ["эту посылку", "ttn"], ["эта посылка", "ttn"], ["этой посылки", "ttn"],
  ["цей товар", "product"], ["цього товару", "product"], ["цьому товару", "product"], ["цим товаром", "product"],
  ["этот товар", "product"], ["этого товара", "product"], ["этому товару", "product"],
  ["цей документ", "document_ref"], ["цей рахунок", "document_ref"], ["цю накладну", "document_ref"], ["цей чек", "document_ref"], ["цього чека", "document_ref"],
  ["цього чеку", "document_ref"], ["этот документ", "document_ref"], ["этот счет", "document_ref"], ["эту накладную", "document_ref"], ["этот чек", "document_ref"],
];

// D70 (intents v3 §4.2): what may follow a new order in one breath and belongs to it («замовлення для Олени …, і відправ новою поштою …», «… і виставити
// рахунок»): the command takes the new order by reference (`refPrevious.order_number`, D27) when it names no order itself (the pilot's convention).
export const ORDER_FOLLOW_UPS: ReadonlySet<string> = new Set([
  "delivery.createShipment", "fiscal.createReceipt", "fiscal.sendReceipt", "payments.createLink", "payments.markPaid", "documents.createFromOrder", "documents.share",
]);

// D79: the personal pronouns a record is said by, with what they agree with (`pronouns.ts`): «її» a woman or a feminine thing, «його» a man or a
// masculine or neuter thing («замовлення»), «їх» several; the dative ones («їй», «йому», «їм») are the person something is for. ru «им» (a man's
// instrumental or several's dative) is left out.
export interface PronounForm {
  readonly gender: "feminine" | "masculine" | null;
  readonly number: "singular" | "plural";
  readonly dative: boolean;
}

const FEMININE: PronounForm = { gender: "feminine", number: "singular", dative: false };
const MASCULINE: PronounForm = { gender: "masculine", number: "singular", dative: false };
const PLURAL: PronounForm = { gender: null, number: "plural", dative: false };

export const PRONOUN_FORMS: ReadonlyMap<string, PronounForm> = new Map<string, PronounForm>([
  ...["її", "неї", "ній", "нею", "её", "ее", "неё", "нее", "ней", "ею"].map((word) => [word, FEMININE] as const),
  ...["їй", "ей"].map((word) => [word, { ...FEMININE, dative: true }] as const),
  ...["його", "нього", "ньому", "ним", "его", "него", "нему"].map((word) => [word, MASCULINE] as const),
  ...["йому", "ему"].map((word) => [word, { ...MASCULINE, dative: true }] as const),
  ...["їх", "них", "ними", "их"].map((word) => [word, PLURAL] as const),
  ...["їм"].map((word) => [word, { ...PLURAL, dative: true }] as const),
]);
