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

// D88 (`focus.ts`): the words a reference to a record in the host's focus is said with, beyond the pronouns above and D70's deictics.
// The record types a focus entry has; a param's type (`customer`, `order_number`, …) is one of them by `FOCUS_PARAM_TYPES`.
export type FocusType = "customer" | "group" | "order" | "product" | "price_list" | "counterparty";
export const FOCUS_PARAM_TYPES: ReadonlyMap<string, FocusType> = new Map<string, FocusType>([
  ["customer", "customer"], ["group", "group"], ["order_number", "order"], ["product", "product"], ["price_list", "price_list"], ["counterparty", "counterparty"],
]);

// A place a record is: a group a customer goes to, an order lines go to, a price list entries go to or leave («додай туди Катю», «прибери звідти
// круасан»). They fill the command's container param, in this order of preference: `group`, then `order_number`, then `price_list`.
export const FOCUS_CONTAINERS: ReadonlySet<string> = new Set(["туди", "сюди", "звідти", "звідси", "там", "туда", "сюда", "оттуда", "отсюда"]);
export const FOCUS_CONTAINER_PARAMS: readonly string[] = ["group", "order_number", "price_list"];
// «сюди», «звідси», «тут»: the record on the screen the person sees, when the host marks one (`screen`).
export const FOCUS_HERE: ReadonlySet<string> = new Set(["сюди", "звідси", "сюда", "отсюда"]);

// «цей / цю / цій / цьому … <noun>», «этот / эту …»: a record of the noun's type said as the one in focus; the screen's record first.
export const FOCUS_THIS: ReadonlySet<string> = new Set([
  "цей", "ця", "це", "цю", "цього", "цьому", "цим", "цієї", "цій", "цією", "этот", "эта", "это", "эту", "этого", "этому", "этим", "этой", "этом",
]);
// «нового клієнта», «нову групу», «новий прайс»: the record of the noun's type the host created (`how: "created"`) first.
export const FOCUS_NEW: ReadonlySet<string> = new Set([
  "новий", "нового", "новому", "новим", "новій", "нова", "нову", "нової", "новою", "нове",
  "новый", "новому", "новым", "новая", "новую", "новой", "новое",
]);
// The nouns of the record types, by the start of the word, uk and ru («клієнта», «клієнтці», «групу», «замовлення», «заказу», «прайс-лист»).
export const FOCUS_NOUNS: readonly (readonly [stem: string, type: FocusType])[] = [
  ["клієнт", "customer"], ["клиент", "customer"], ["покупц", "customer"], ["покупец", "customer"],
  ["груп", "group"],
  ["замовлен", "order"], ["заказ", "order"],
  ["прайс", "price_list"],
  ["контрагент", "counterparty"],
  ["товар", "product"],
];
// The prepositions a pronoun is said after («для неї», «по ньому», «в неї», «у него»): the span of the reference holds them.
export const FOCUS_PREPOSITIONS: ReadonlySet<string> = new Set([
  "для", "по", "на", "в", "у", "до", "з", "із", "зі", "від", "про", "за", "к", "с", "со", "из", "от", "о", "об",
]);
// «і ще 2 круасани», «а ще булочку», «и ещё два»: an order said on after the order the host just created (`focus.ts` `continued`).
export const CONTINUATION_LEADS: ReadonlySet<string> = new Set(["і", "й", "а", "та", "и"]);
export const CONTINUATION_MORE: ReadonlySet<string> = new Set(["ще", "ещё", "еще"]);

// D89 (`focus.ts` `byFocusType`): a bare verb said of a record in focus («видали її», «заархівуй його», «перейменуй її на …», «відкрий його»; no type
// noun) is the verb's action for the referent's type. The verbs by family, uk / ru / surzhyk, the imperative and the infinitive; the rename verbs are
// D85's `RENAME_VERBS`. «скасуй» is no delete verb (only an order is cancelled), «прибери» neither (entries and lines are removed).
export type FocusVerb = "delete" | "archive" | "restore" | "rename" | "open";
export const FOCUS_VERBS: ReadonlyMap<string, FocusVerb> = new Map<string, FocusVerb>([
  ...["видали", "видаліть", "видалити", "видаляй", "видаляйте", "удали", "удалите", "удалить", "удаляй", "удаляйте", "вилучи", "вилучіть", "стери", "зітри", "сотри"].map((word) => [word, "delete"] as const),
  ...["заархівуй", "заархівуйте", "заархівувати", "архівуй", "архівуйте", "заархивируй", "заархивируйте", "заархивировать", "архивируй", "архивируйте"].map((word) => [word, "archive"] as const),
  ...["віднови", "відновіть", "відновити", "розархівуй", "розархівуйте", "розархівувати", "восстанови", "восстановите", "восстановить", "разархивируй", "разархивируйте", "разархивировать"].map((word) => [word, "restore"] as const),
  ...["відкрий", "відкрийте", "відкрити", "открой", "откройте", "открыть", "покажи", "покажіть", "показати", "покажите", "показать"].map((word) => [word, "open"] as const),
]);
// «перенеси його в архів», «верни її з архіву»: the archive said as a place.
export const FOCUS_ARCHIVE_PHRASES: readonly (readonly [phrase: string, verb: FocusVerb])[] = [
  ["в архів", "archive"], ["до архіву", "archive"], ["в архив", "archive"],
  ["з архіву", "restore"], ["із архіву", "restore"], ["из архива", "restore"],
];

// D92 (P1 of the v3.4 served report, `createAsUpdate.ts` `updateAsCreate`): the words that say an order already exists, so a served `orders.update` with
// no order keeps the model's update. The order noun in any form but the bare one («в замовленні», «до заказу», «замовленню»), or the bare one after a
// preposition («в замовлення», «у заказ»); a verb that adds to, changes or takes from an order, by the start of the word, uk / ru / surzhyk. «ще» is
// D88's `CONTINUATION_MORE`.
export const ORDER_NOUN_BARE: ReadonlySet<string> = new Set(["замовлення", "заказ"]);
export const ORDER_NOUN_STEMS: readonly string[] = ["замовлен", "заказ"];
export const ORDER_NOUN_LEADS: ReadonlySet<string> = new Set(["в", "у", "во", "до", "к", "ко", "із", "з", "зі", "из", "с", "со"]);
export const ORDER_EDIT_STEMS: readonly string[] = [
  "дода", "добав", "допи", "докин", "докла", "докуп", "дозамов", "дозаказ",
  "замін", "замен", "змін", "измен", "помін", "помен", "виправ", "исправ", "онов", "обнов", "редаг", "відредаг", "отредакт", "скориг", "скоррект",
  "прибер", "прибра", "убер", "убра", "видал", "удал", "вилуч", "перенес",
];
