import { intentOfAction, type Bundle } from "./bundle.ts";
import type { CompiledContext } from "./catalogue.ts";
import { MONEY_CUES, MONEY_PHRASES, TILL_CUES } from "./lexicon/fiscal.ts";
import { isLines, type ParamValue, type Params } from "./params.ts";
import type { Unsupported } from "./stockless.ts";

// D89 (3), the owner (2026-09-30): «Це має вирішувати додаток, якщо у компанії є каса — тоді це каса, якщо ні — просто повернення коштів.» Money given
// back is a till return (`fiscal.returnReceipt`, a return receipt through the shop's ПРРО) or a refund (`payments.refund`, money back to the card or
// the account); the words rarely say which, and the model's choice between them is a coin toss. The app says whether the shop has a till: context v2
// `capabilities.fiscal` (as D72's `capabilities.stock`). When the served action is one of the two:
//   - the words say which (`lexicon/fiscal.ts`): a receipt or the till («по чеку 45», «через касу») is the till return, the money or where it goes
//     («поверни гроші», «кошти на картку») the refund; that one is served (both cues, or none: the capability decides);
//   - else the capability decides: a till (`fiscal: true`) is the till return, none (`fiscal: false`) the refund;
//   - no till, and the words say «чек»: the refund, with the non-blocking need `{path: "fiscal", reason: "unsupported"}` (the shop has no till).
// The params that both take move (`order_number`, `customer`, `amount`); what the refund does not take is dropped, a said receipt number or items each
// with a non-blocking `ignored` need on its path (`document_type`, an enum, silently). Without the capability (a v1 context, a v2 one without the field)
// nothing changes.

export interface Dropped {
  readonly path: string;
  readonly text: string;
}

export interface TillRoute {
  readonly action: string;
  readonly params: Params;
  readonly unsupported?: Unsupported;
  readonly dropped: readonly Dropped[];
}

const RETURN = "fiscal.returnReceipt";
const REFUND = "payments.refund";
// The span params the refund does not take, noted on the card when said.
const NOTED: readonly string[] = ["document_ref", "items"];

function saidText(value: ParamValue): string {
  if (isLines(value)) return value.map((line) => [line.quantity, line.product, ...line.attrs].filter(Boolean).join(" ")).join(", ");
  return typeof value === "string" ? value : value.join(", ");
}

export interface Cues {
  readonly till: boolean;
  readonly money: boolean;
}

// What the words say: the receipt or the till, the money or where it goes (both may be said).
export function moneyCues(utterance: string): Cues {
  const words = utterance.toLowerCase().split(/\s+/).filter(Boolean);
  const text = ` ${words.join(" ")} `;
  return { till: words.some((word) => TILL_CUES.has(word)), money: words.some((word) => MONEY_CUES.has(word)) || MONEY_PHRASES.some((phrase) => text.includes(` ${phrase} `)) };
}

export function tillRoute(bundle: Pick<Bundle, "intents">, action: string, params: Params, utterance: string, context: CompiledContext): TillRoute | null {
  const fiscal = context.records.shop.fiscal;
  if (fiscal === null || (action !== RETURN && action !== REFUND) || !Object.hasOwn(bundle.intents, RETURN) || !Object.hasOwn(bundle.intents, REFUND)) return null;
  const { till, money } = moneyCues(utterance);
  const want = money && !till ? REFUND : fiscal ? RETURN : REFUND;
  const unsupported: Unsupported | undefined = !fiscal && till ? { path: "fiscal", blocking: false } : undefined;
  if (want === action && unsupported === undefined) return null;
  const takes = intentOfAction(bundle, want).intent.params;
  const kept: Record<string, ParamValue> = {};
  const dropped: Dropped[] = [];
  for (const [name, value] of Object.entries(params)) {
    if (Object.hasOwn(takes, name)) kept[name] = value;
    else if (NOTED.includes(name)) dropped.push({ path: name, text: saidText(value) });
  }
  return { action: intentOfAction(bundle, want).action, params: kept, dropped, ...(unsupported === undefined ? {} : { unsupported }) };
}
