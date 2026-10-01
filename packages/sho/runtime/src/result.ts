import type { ActionName, IntentKind } from "./bundle.ts";
import type { Inference } from "./pipeline.ts";
import type { SaleUnit } from "./lexicon/units.ts";
import type { PaymentMethodKey } from "./lexicon/roles.ts";
import type { Currency } from "./lexicon/values.ts";
import type { Address, Branch, City, MeasureValue, Money, Ttn } from "./values.ts";
import type { When } from "./when.ts";

// Result v2, what ШО returns (docs/design/sho-api-v2.md §3, D65): every param typed, record refs resolved against the context where it decides, order
// items with their attrs matched as a set against the product's variants, and what the card still needs.

export const RESULT_SCHEMA = "sho-result/2";

// resolved: one record (its id and name); ambiguous: several fit (candidates for a picker); unknown: the list was checked and nothing fits; unchecked:
// the context lacks the list, or it is partial and missed, or the ref is a phone or an ЄДРПОУ, which never go to the device: the host resolves the text;
// previous: made by an earlier command of this result (`command` is its index, D27); context (v3, D70): said by a word that points at a record («їй»,
// «цю ТТН», «це замовлення»), which the host fills from the record on screen or its last result (intents v3 §6d).
export type RefStatus = "resolved" | "ambiguous" | "unknown" | "unchecked" | "previous" | "context";

// How the words named the record: its whole name as written, a word form of it, an alias, by sound in the other script, a part of it, by the attrs said
// with it, or the only variant a product has. D94: a customer by a phone or an e-mail the context holds (`contacts.ts`).
export type Match = "exact" | "form" | "alias" | "sound" | "part" | "attrs" | "only" | "phone" | "email";

export interface Candidate {
  readonly id: string | null;
  readonly name: string;
  readonly productId?: string | null;
  readonly label?: string;
}

// D78: a record near a name the context does not know, with how near (0 to 1; `nearest.ts`).
export interface NearCandidate extends Candidate {
  readonly score: number;
}

// D78: the command that would create what the context does not know, its params filled from what was said (`suggest.ts`): `new_name` the words as said,
// and the command's own params the create intent takes (a price, a phone); `attrs`, the attr words said with a product that is not in the catalogue.
export interface Suggestion {
  readonly action: ActionName;
  readonly params: Readonly<Record<string, Param>>;
  readonly attrs?: readonly string[];
}

// `confidence`: the mean tag probability of the model span the text came from (absent when no model span holds it: a word the catalogue pass took, a
// text taken over from an earlier command). D78: an `unknown` ref also has `nearest`, the records near its words (none when none is near enough), and
// `suggest`, the command that creates it (when the bundle has one); both are absent otherwise.
export interface Ref {
  readonly text: string;
  readonly status: RefStatus;
  readonly id?: string | null;
  readonly name?: string;
  readonly match?: Match;
  readonly candidates?: readonly Candidate[];
  readonly truncated?: true;
  readonly command?: number;
  readonly confidence?: number;
  readonly nearest?: readonly NearCandidate[];
  readonly suggest?: Suggestion;
  // D88: a ref a reference word took from the host's focus (`RunOptions.focus`): the index of the focus entry it is (`status: "context"`, with its `id`
  // and `name`; D90: the one a `check_reference` need offers too), or `true` on an `ambiguous` ref whose `candidates` are the focus entries that fit.
  readonly focus?: number | true;
  // D94: a customer said by a contact, not a name («клієнта з номером 067 …», «з поштою …»): `by` the kind of contact, `text` the contact as said,
  // `value` a phone's digits as recognised (no country code guessed) or an e-mail in lower case. `unchecked` unless the context holds the customers'
  // contacts: the host looks the customer up by `value`; never `nearest`, and `suggest` only on an `unknown` the context's contacts gave.
  readonly by?: "phone" | "email";
  readonly value?: string;
}

// variantIds null: not checked (the product is not resolved, or the context does not know its variants); []: the attr matches no variant of the product.
// D78: an attr no variant of the resolved product has (`variantIds` []) also has `nearest`, the product's variants with a value near it, and `suggest`, the
// variant to create (`catalog.createVariant`: the product and the line's attrs as said) unless the line's other attrs already name one variant.
export interface Attr {
  readonly text: string;
  readonly variantIds: readonly string[] | null;
  readonly confidence?: number;
  readonly nearest?: readonly NearCandidate[];
  readonly suggest?: Suggestion;
}

// unspecified: a product with variants and no attr said; none: the product sells as itself.
export type VariantStatus = "resolved" | "ambiguous" | "unknown" | "unspecified" | "none" | "unchecked";

export interface VariantRef {
  readonly status: VariantStatus;
  readonly id?: string;
  readonly name?: string;
  readonly match?: Match;
  readonly candidates?: readonly Candidate[];
  readonly truncated?: true;
}

// `text`: the one span that gives the value, null when several were summed (D60) or none was said as a number («дві пари … 38 і 39», one each); `said`:
// every span that went into the value; `value`: 1 when nothing was said, null when the span says no number («пару»), converted to the product's unit
// («500 г» of a product sold by the kilo is 0.5, `unit` "kg"); `unitText`: the unit word as said.
export interface Quantity {
  readonly text: string | null;
  readonly said: readonly string[];
  readonly value: number | null;
  readonly unit: SaleUnit | null;
  readonly unitText: string | null;
  readonly implicit?: true;
  readonly confidence?: number;
}

export interface OrderItem {
  readonly product: Ref;
  readonly attrs: readonly Attr[];
  readonly variant: VariantRef;
  readonly quantity: Quantity;
}

export interface VariantParam extends VariantRef {
  readonly text: string;
  readonly attrs: readonly Attr[];
  readonly confidence?: number;
}

// v3 (D69): money as minor units and a currency (cash on delivery also says its `mode`), a `when`, a ТТН, a branch, a weight or a parcel's sides, a
// city (with `role` from / to in `delivery.estimate`).
// D70: a part of a mixed payment (`split`) also says the method the word after it names («500 готівкою»); an address is split lightly.
export type MoneyValue = Money & { readonly mode?: "cod" | "payment_control"; readonly method?: PaymentMethodKey };
export type CityValue = City & { readonly role?: "from" | "to" };
export type SpanValue = number | string | MoneyValue | When | Ttn | Branch | MeasureValue | CityValue | Address;

export interface SpanParam {
  readonly text: string;
  readonly value?: SpanValue;
  readonly confidence?: number;
}

// A part of a mixed payment as the card shows it (D70): its method, its amount in minor units (null for the rest when the total is not said), and
// `rest` for «решта карткою».
export interface PaymentPart {
  readonly method: PaymentMethodKey | null;
  readonly minor: number | null;
  readonly currency: Currency;
  readonly rest?: true;
}

// `parts` (v3, D70): `payment_method: mixed` pairs each part of the payment with its method.
export interface EnumParam {
  readonly value: string;
  readonly parts?: readonly PaymentPart[];
}

// v3.1 (D75): a list of enum values (`tax` of `accounting.taxDue` / `taxDeadlines`, «єп та військовий збір» ["single_tax", "military_levy"]), the
// values themselves in the head's order; a v3 bundle's `tax` stays one `EnumParam`.
export type EnumValues = readonly string[];

// `readonly Attr[]`: the attrs of `stock.get`, `stock.set` and `analytics.summary`, matched against the product's variants (v3, D70).
export type Param = Ref | readonly Ref[] | VariantParam | readonly OrderItem[] | SpanParam | readonly SpanParam[] | EnumParam | readonly Attr[] | EnumValues;

// v3 (D69): `invalid_value`, a span its type's reader cannot read (a ТТН of another length, a percent over 100, a `when` it does not know), and
// `postomat_limit`, a parcel that does not fit a parcel locker (non-blocking); D70: `ambiguous_role`, a span two params could take and no cue word
// placed (a shipment's sum: cash on delivery or the declared value?), with `path` the params joined by «|» and `span` the span itself.
export type NeedReason =
  | "missing" | "ambiguous" | "unknown" | "variant_required" | "unknown_attr" | "quantity_asks" | "unit_mismatch" | "duplicate_line"
  | "invalid_value" | "postomat_limit" | "ambiguous_role"
  // D72: the shop cannot do what was asked (`path` "stock": it tracks no stock); the command is the nearest question it can answer, if any. D89: `path`
  // "fiscal", no till. D93: `path` "action", blocking: the words name as the verb's object a thing the action's type is not and ШО does not handle
  // (a product group or category, a chat, a staff member, the shop's own requisites; `span` the object as said); the card declines.
  | "unsupported"
  // D78: a refinement (`ui.refine`) said a filter the command it refines does not take (`path` the refinement's param, `span` what was said); the
  // command runs without it. Non-blocking.
  | "ignored"
  // D81: words from a command verb on that this command holds nothing of and that were not served as a command of their own (`path` "text", `span`
  // the words as said); the host shows them («Також було: …»). Non-blocking.
  | "unparsed"
  // D84: the model's `customers.createCustomer` was served as `customers.updateCustomer` of the customer the list knows by that name, said in the
  // dative (`path` "action", `span` the name as said); the card says so. Non-blocking.
  | "read_as_update"
  // D85: the model's `customers.updateGroup` was served as `customers.updateCustomer` of the customer the list knows by the name said as the group
  // (`path` "action", `span` the name as said); the card says so. Non-blocking.
  | "read_as_customer_update"
  // D88: a reference word («для неї», «туди», «цю групу») said for a record the command takes, when the host passed a focus and no record of the
  // param's type in it fits (none, another type or gender, closed): `path` the param, `span` the words; blocking.
  | "reference"
  // D89: a bare verb said of a record in focus («видали її» after a customer) was served as that verb's action for the record's type
  // (`customers.deleteCustomer`, not the model's `orders.cancel`): `path` "action", `span` the reference word as said; the card says so. Non-blocking.
  | "read_as_focus_type"
  // D90: a reference word whose record the focus only offers (touched in an earlier conversation, three commands ago or more, opened by hand and left,
  // or a list of its type shown since): the param holds that record's ref (`status: "context"`, `id`, `name`, `focus`) and the card asks to confirm it
  // with one tap («Для Софії Мельник?»); `path` the param, `span` the words; blocking.
  | "check_reference"
  // D92: the model's `orders.update` with a customer and items, no order and no word that says one exists, was served as that customer's new order
  // (`orders.create`, the same params): `path` "action", `span` the customer as said; the card says so. Non-blocking.
  | "read_as_create"
  // D94: the model's `customers.createCustomer` that says only a phone or an e-mail, with a find word («знайди», «пошукай», «чий») and no word that
  // makes a record, was served as `customers.getCustomer` with that contact (`path` "action", `span` the contact as said); the card says so.
  // Non-blocking.
  | "read_as_find"
  // D93: the utterance has letters and no Cyrillic word (English, a transliteration): ШО reads only Ukrainian and Russian, so the model is not run and
  // the one command is `none` with confidence 0 and this need (`path` "text", non-blocking); the host sends the message to its dialogue model.
  | "language";

// A blocking need keeps the card from being confirmed until it is answered; a non-blocking one is shown on the card.
export interface Need {
  readonly path: string;
  readonly reason: NeedReason;
  readonly blocking: boolean;
  readonly span?: SpanParam;
}

export type Effect = "none" | "ui" | "navigate" | "read" | "write" | "destructive";
export type Confirmation = "none" | "card" | "strong";

// `spans`: the lowest confidence of any param span (1 with none).
export interface ConfidenceV2 {
  readonly action: number;
  readonly margin: number;
  readonly certainty: number;
  readonly spans: number;
}

export interface CommandV2 {
  readonly text: string;
  readonly action: ActionName;
  readonly kind: IntentKind;
  readonly effect: Effect;
  readonly confirm: Confirmation;
  readonly params: Readonly<Record<string, Param>>;
  readonly needs: readonly Need[];
  readonly ready: boolean;
  readonly refPrevious: Readonly<Record<string, number>>;
  // The order lines were read against the catalogue (the demo's «позиції звірено з каталогом»).
  readonly catalogued: boolean;
  readonly confidence: ConfidenceV2;
  // v3 (D69): the aux heads' domain and verb («delivery», «create»), so that a host without that domain can say «ще не підключено» instead of «не
  // зрозумів»; absent for a v2 bundle.
  readonly domain?: string;
  readonly verb?: string;
  // D78: the command is a refinement («а за минулий», `ui.refine`) merged into the previous command the host gave (`RunOptions.previous`): the text of
  // that command. `action`, `params` and `needs` are the merged command's.
  readonly refines?: string;
  // D88: on a command that creates a record the host keeps in its focus (a customer, a group, an order, a product, a price list, a counterparty), when
  // the run passed `focus`: the record's type and name (a customer's in the nominative when the runtime can tell it; null for an order), so the host
  // pushes it into the focus with the id its API returns.
  readonly creates?: Creates;
  readonly debug?: Inference;
}

export interface Creates {
  readonly type: "customer" | "group" | "order" | "product" | "price_list" | "counterparty";
  readonly name: string | null;
}

export interface ContextInfo {
  readonly version: 1 | 2;
  readonly revision: string | null;
}

export interface DebugV2 {
  readonly first: Inference;
  readonly passes: readonly Inference[];
  readonly total: number;
}

export interface ResultV2 {
  readonly schema: typeof RESULT_SCHEMA;
  readonly raw: string | null;
  readonly text: string;
  readonly segments: readonly string[];
  readonly tooMany: boolean;
  // What a host acts on (D56).
  readonly commands: readonly CommandV2[];
  // The whole utterance read as one command: diagnostics only.
  readonly first: CommandV2;
  readonly context: ContextInfo | null;
  readonly debug?: DebugV2;
}
