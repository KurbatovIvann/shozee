import { BundleError } from "./errors.ts";
import { parseTokenizerSpec, type TokenizerSpec } from "./tokenizer.ts";

export type ActionName = string & { readonly __brand: "ActionName" };
// "read-modifier" (intents v3.2, D78): `ui.refine`, a follow-up that refines the previous read command (`refine.ts`).
export type IntentKind = "nav" | "read" | "write" | "high" | "ui" | "none" | "read-modifier";
export type ParamType = string;
export type EnumKey = string;

export interface Intent {
  readonly kind: IntentKind;
  readonly route: string | null;
  readonly params: Readonly<Record<string, ParamType>>;
}

export interface LineFields {
  readonly product: string;
  readonly variant: string;
  readonly quantity: string;
}

export interface BundleId {
  readonly onnx: string;
  readonly tokenizer: string;
  readonly labels: string;
}

export interface Bundle {
  readonly id: BundleId | null;
  readonly maxLength: number;
  readonly bosId: number;
  readonly eosId: number;
  readonly outputs: readonly string[];
  readonly actions: readonly ActionName[];
  readonly intents: Readonly<Record<ActionName, Intent>>;
  readonly enumTypes: ReadonlySet<ParamType>;
  readonly enums: Readonly<Record<EnumKey, readonly string[]>>;
  readonly colliding: ReadonlySet<ParamType>;
  readonly lineFields: LineFields;
  readonly listTypes: Readonly<Record<ParamType, string>>;
  readonly rangeSpan: string;
  readonly tags: readonly string[];
  readonly hasSegmentHead: boolean;
  readonly tokenizer: TokenizerSpec;
  // The label set a bundle was trained on: "v3" for the multi-domain catalogue (intents v3, D69), null for the v2 bundles, which name none. The v3
  // readers (typed values, roles, quarters and years) run only for a "v3" bundle, so a v2 bundle decodes as it always did.
  readonly catalogue: string | null;
  // Params whose type is one of several tags (v3: `discount` is a `percent` or a `money` span).
  readonly unions: Readonly<Record<ParamType, readonly string[]>>;
  // The auxiliary first-token heads (v3: `domain`, `verb`) by name, with their labels; the runtime reads them only to report them (D69).
  readonly aux: Readonly<Record<string, readonly string[]>>;
  // v3.1 (D75): a param type that is a list of enum values (`tax_list`) → its multi-label head (`tax`, output `list_tax`), the head's values and the
  // probability each value must reach. All three are empty for a v2 or v3 bundle, whose `tax` is a one-value enum: it decodes as before.
  readonly listEnums: Readonly<Record<ParamType, EnumKey>>;
  readonly listHeads: Readonly<Record<EnumKey, readonly string[]>>;
  readonly listThresholds: Readonly<Record<EnumKey, readonly number[]>>;
}

export const BUNDLE_FORMAT = "sho-bundle/1";
export const ORDER_LINES: ParamType = "order_lines";

const INTENT_KINDS: ReadonlySet<string> = new Set<IntentKind>(["nav", "read", "write", "high", "ui", "none", "read-modifier"]);
const TAG = /^[BI]-./;

type Json = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown, code: string, what: string): Json {
  if (!isObject(value)) throw new BundleError(code, `${what} is not an object`);
  return value;
}

function text(value: unknown, code: string, what: string): string {
  if (typeof value !== "string") throw new BundleError(code, `${what} is not a string`);
  return value;
}

function integer(value: unknown, code: string, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new BundleError(code, `${what} is not a non-negative integer`);
  return value;
}

function texts(value: unknown, code: string, what: string): string[] {
  if (!Array.isArray(value)) throw new BundleError(code, `${what} is not an array`);
  return value.map((item: unknown, index) => text(item, code, `${what}[${index}]`));
}

function unique(values: readonly string[], code: string, what: string): void {
  if (new Set(values).size !== values.length) throw new BundleError(code, `${what} has duplicates`);
}

function isIntentKind(value: string): value is IntentKind {
  return INTENT_KINDS.has(value);
}

function isActionName(intents: Json, value: string): value is ActionName {
  return Object.hasOwn(intents, value);
}

function intentOf(name: string, json: unknown): Intent {
  const intent = object(json, "labels_intent", `intent ${name}`);
  const kind = text(intent["kind"], "labels_intent", `intent ${name} kind`);
  if (!isIntentKind(kind)) throw new BundleError("labels_intent", `intent ${name} has unknown kind ${kind}`);
  const route = intent["route"] === null ? null : text(intent["route"], "labels_intent", `intent ${name} route`);
  const params = Object.entries(object(intent["params"], "labels_intent", `intent ${name} params`));
  return { kind, route, params: Object.fromEntries(params.map(([param, type]) => [param, text(type, "labels_intent", `intent ${name} param ${param}`)])) };
}

function enumsOf(json: unknown): Record<EnumKey, readonly string[]> {
  const entries = Object.entries(object(json, "labels_enums", "enums"));
  return Object.fromEntries(entries.map(([key, values]) => [key, texts(values, "labels_enums", `enums.${key}`)]));
}

// The tag of an order line's attribute words is `line_fields.attr` in the bundles of the retrained tag set, `line_fields.variant` before it (D65, Q5):
// either names the attrs.
function lineFieldsOf(json: unknown): LineFields {
  const fields = object(json, "labels_line_fields", "line_fields");
  const attr = fields["attr"] === undefined ? "variant" : "attr";
  return {
    product: text(fields["product"], "labels_line_fields", "line_fields.product"),
    variant: text(fields[attr], "labels_line_fields", `line_fields.${attr}`),
    quantity: text(fields["quantity"], "labels_line_fields", "line_fields.quantity"),
  };
}

function listTypesOf(json: unknown): Record<ParamType, string> {
  if (json === undefined) return {};
  const entries = Object.entries(object(json, "labels_list_types", "list_types"));
  return Object.fromEntries(entries.map(([type, item]) => [type, text(item, "labels_list_types", `list_types.${type}`)]));
}

export function listItemType(bundle: Pick<Bundle, "listTypes">, type: ParamType): string | undefined {
  return Object.hasOwn(bundle.listTypes, type) ? bundle.listTypes[type] : undefined;
}

function checkTags(tags: readonly string[]): ReadonlySet<string> {
  if (tags[0] !== "O") throw new BundleError("labels_tags", "tags[0] is not O");
  const kinds = new Set<string>();
  for (const tag of tags.slice(1)) {
    if (!TAG.test(tag)) throw new BundleError("labels_tags", `tag ${tag} is not B-<kind> or I-<kind>`);
    kinds.add(tag.slice(2));
  }
  unique(tags, "labels_tags", "tags");
  return kinds;
}

function unionsOf(json: unknown, spanKinds: ReadonlySet<string>): Record<ParamType, readonly string[]> {
  if (json === undefined) return {};
  const entries = Object.entries(object(json, "labels_unions", "unions"));
  return Object.fromEntries(entries.map(([type, members]) => {
    const kinds = texts(members, "labels_unions", `unions.${type}`);
    const unknown = kinds.find((kind) => !spanKinds.has(kind));
    if (!kinds.length || unknown !== undefined) throw new BundleError("labels_unions", `unions.${type} names ${unknown ?? "no"} tag`);
    return [type, kinds];
  }));
}

export const LIST_THRESHOLD = 0.5;

interface ListEnums {
  readonly listEnums: Record<ParamType, EnumKey>;
  readonly listHeads: Record<EnumKey, readonly string[]>;
  readonly listThresholds: Record<EnumKey, readonly number[]>;
}

function probabilities(value: unknown, width: number, what: string): number[] {
  if (!Array.isArray(value) || value.length !== width) throw new BundleError("labels_list_thresholds", `${what} is not a list of ${width} numbers`);
  return value.map((item: unknown, index) => {
    if (typeof item !== "number" || !(item > 0 && item < 1)) throw new BundleError("labels_list_thresholds", `${what}[${index}] is not a number between 0 and 1`);
    return item;
  });
}

// v3.1 (D75): `list_enums` (param type → head), `list_heads` (head → values), `list_thresholds` (head → one probability per value, 0.5 when absent).
function listEnumsOf(json: Json, outputs: readonly string[]): ListEnums {
  if (json["list_enums"] === undefined) return { listEnums: {}, listHeads: {}, listThresholds: {} };
  const types = Object.entries(object(json["list_enums"], "labels_list_enums", "list_enums")).map(([type, key]) => [type, text(key, "labels_list_enums", `list_enums.${type}`)] as const);
  const heads = Object.entries(object(json["list_heads"], "labels_list_heads", "list_heads")).map(([key, values]) => {
    const found = texts(values, "labels_list_heads", `list_heads.${key}`);
    if (!found.length) throw new BundleError("labels_list_heads", `list_heads.${key} has no values`);
    unique(found, "labels_list_heads", `list_heads.${key}`);
    if (!outputs.includes(`list_${key}`)) throw new BundleError("labels_outputs", `outputs lack head list_${key}`);
    return [key, found] as const;
  });
  const listHeads: Record<EnumKey, readonly string[]> = Object.fromEntries(heads);
  for (const [type, key] of types) if (!Object.hasOwn(listHeads, key)) throw new BundleError("labels_list_enums", `list_enums.${type} names no list head ${key}`);
  const thresholds = json["list_thresholds"] === undefined ? {} : object(json["list_thresholds"], "labels_list_thresholds", "list_thresholds");
  const listThresholds = Object.fromEntries(heads.map(([key, values]) => [key, thresholds[key] === undefined ? values.map(() => LIST_THRESHOLD) : probabilities(thresholds[key], values.length, `list_thresholds.${key}`)]));
  return { listEnums: Object.fromEntries(types), listHeads, listThresholds };
}

export function listHeadOf(bundle: Pick<Bundle, "listEnums">, type: ParamType): EnumKey | undefined {
  return Object.hasOwn(bundle.listEnums, type) ? bundle.listEnums[type] : undefined;
}

function auxOf(json: unknown, outputs: readonly string[]): Record<string, readonly string[]> {
  if (json === undefined) return {};
  const entries = Object.entries(object(json, "labels_aux", "aux"));
  return Object.fromEntries(entries.filter(([name]) => outputs.includes(`aux_${name}`)).map(([name, labels]) => [name, texts(labels, "labels_aux", `aux.${name}`)]));
}

function checkParams(
  intents: Readonly<Record<string, Intent>>,
  spanKinds: ReadonlySet<string>,
  enumTypes: ReadonlySet<string>,
  colliding: ReadonlySet<string>,
  enums: Json,
  listTypes: Readonly<Record<string, string>>,
  unions: Readonly<Record<string, readonly string[]>>,
  listEnums: Readonly<Record<string, string>>,
): void {
  for (const [action, intent] of Object.entries(intents)) {
    for (const [name, type] of Object.entries(intent.params)) {
      if (type === ORDER_LINES || Object.hasOwn(unions, type) || Object.hasOwn(listEnums, type)) continue;
      const item = Object.hasOwn(listTypes, type) ? listTypes[type] : undefined;
      if (item !== undefined) {
        if (!spanKinds.has(item)) throw new BundleError("labels_param_type", `${action}.${name} is a list of ${item}, which is no tag`);
        continue;
      }
      if (enumTypes.has(type)) {
        const key = colliding.has(type) ? name : type;
        if (!Object.hasOwn(enums, key)) throw new BundleError("labels_param_type", `${action}.${name} needs enum head ${key}`);
      } else if (!spanKinds.has(type)) {
        throw new BundleError("labels_param_type", `${action}.${name} has type ${type}, which is no tag, enum, list or ${ORDER_LINES}`);
      }
    }
  }
}

function checkOutputs(outputs: readonly string[], enums: Json): void {
  for (const head of ["action", "tags", ...Object.keys(enums).map((key) => `enum_${key}`)]) {
    if (!outputs.includes(head)) throw new BundleError("labels_outputs", `outputs lack head ${head}`);
  }
}

export function parseBundle(labels: unknown, tokenizer: unknown, id: BundleId | null = null): Bundle {
  const json = object(labels, "labels", "labels.json");
  if (json["format"] !== undefined && json["format"] !== BUNDLE_FORMAT) throw new BundleError("labels_format", `labels.json format ${String(json["format"])} is not ${BUNDLE_FORMAT}`);
  const outputs = texts(json["outputs"], "labels_outputs", "outputs");
  const intentsJson = object(json["intents"], "labels_intents", "intents");
  const intents: Readonly<Record<ActionName, Intent>> = Object.fromEntries(Object.entries(intentsJson).map(([name, intent]) => [name, intentOf(name, intent)]));
  const actions = texts(json["actions"], "labels_actions", "actions").map((name) => {
    if (!isActionName(intentsJson, name)) throw new BundleError("labels_actions", `action ${name} has no intent`);
    return name;
  });
  unique(actions, "labels_actions", "actions");
  const enums = enumsOf(json["enums"]);
  const enumTypes = new Set(texts(json["enum_types"], "labels_enum_types", "enum_types"));
  const colliding = new Set(texts(json["colliding"], "labels_colliding", "colliding"));
  const tags = texts(json["tags"], "labels_tags", "tags");
  const spanKinds = checkTags(tags);
  const lineFields = lineFieldsOf(json["line_fields"]);
  const listTypes = listTypesOf(json["list_types"]);
  const rangeSpan = text(json["range_span"], "labels_range_span", "range_span");
  if (!spanKinds.has(rangeSpan)) throw new BundleError("labels_range_span", `range_span ${rangeSpan} is no tag kind`);
  const unions = unionsOf(json["unions"], spanKinds);
  const lists = listEnumsOf(json, outputs);
  checkParams(intents, spanKinds, enumTypes, colliding, enums, listTypes, unions, lists.listEnums);
  checkOutputs(outputs, enums);
  const catalogue = json["catalogue"] === undefined ? null : text(json["catalogue"], "labels_catalogue", "catalogue");
  return {
    id,
    maxLength: integer(json["max_length"], "labels_max_length", "max_length"),
    bosId: integer(json["bos_id"], "labels_special_ids", "bos_id"),
    eosId: integer(json["eos_id"], "labels_special_ids", "eos_id"),
    outputs,
    actions,
    intents,
    enumTypes,
    enums,
    colliding,
    lineFields,
    listTypes,
    rangeSpan,
    tags,
    hasSegmentHead: outputs.includes("segment"),
    tokenizer: parseTokenizerSpec(tokenizer),
    catalogue,
    unions,
    aux: auxOf(json["aux"], outputs),
    ...lists,
  };
}

export const CATALOGUE_V3 = "v3";

export function isV3(bundle: Pick<Bundle, "catalogue">): boolean {
  return bundle.catalogue === CATALOGUE_V3;
}

// The tags a param of this type takes: its own tag, a list's item tag, a union's members (none for an enum or order lines).
export function spanKindsOf(bundle: Pick<Bundle, "listTypes" | "unions">, type: ParamType): readonly string[] {
  if (Object.hasOwn(bundle.unions, type)) return bundle.unions[type] ?? [];
  return [listItemType(bundle, type) ?? type];
}

export function intentOfAction(bundle: Pick<Bundle, "intents">, action: string): { readonly action: ActionName; readonly intent: Intent } {
  const intents: Readonly<Record<string, Intent>> = bundle.intents;
  const intent = intents[action];
  if (intent === undefined || !isActionName(intents, action)) throw new BundleError("labels_intents", `action ${action} has no intent`);
  return { action, intent };
}
