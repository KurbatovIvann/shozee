import type { Bundle } from "./bundle.ts";
import type { Heads, Logits } from "./decode.ts";
import { ModelError } from "./errors.ts";

export interface RawTensor {
  readonly data: Float32Array;
  readonly dims: readonly number[];
}

export type RawOutputs = Readonly<Record<string, RawTensor>>;

export interface ModelRunner {
  run(ids: readonly number[]): Promise<RawOutputs>;
  dispose(): Promise<void>;
}

const SEGMENT_WIDTH = 2;

function tensor(outputs: RawOutputs, name: string): RawTensor {
  const found = Object.hasOwn(outputs, name) ? outputs[name] : undefined;
  if (found === undefined) throw new ModelError("output_missing", `the model returned no ${name} output`);
  const size = found.dims.reduce((product, dim) => product * dim, 1);
  if (size !== found.data.length) throw new ModelError("output_shape", `${name} has dims [${found.dims.join(", ")}] but ${found.data.length} values`);
  return found;
}

function vector(outputs: RawOutputs, name: string, width: number): Logits {
  const found = tensor(outputs, name);
  if (found.data.length !== width) throw new ModelError("output_width", `${name} has ${found.data.length} values, the bundle expects ${width}`);
  return Array.from(found.data);
}

function rows(outputs: RawOutputs, name: string, length: number, width: number): Logits[] {
  const found = tensor(outputs, name);
  if (found.data.length !== length * width) throw new ModelError("output_width", `${name} has ${found.data.length} values, the bundle expects ${length} tokens × ${width}`);
  return Array.from({ length }, (_, row) => Array.from(found.data.subarray(row * width, (row + 1) * width)));
}

// The aux heads (v3 `aux_domain`, `aux_verb`, D69) are read when the bundle names them; a v2 bundle has none.
// v3.1 (D75): the list heads (`list_tax`) when the bundle names them.
export function headsOf(bundle: Pick<Bundle, "actions" | "tags" | "enums" | "hasSegmentHead" | "aux" | "listHeads">, outputs: RawOutputs, length: number): Heads {
  const heads: Heads = {
    action: vector(outputs, "action", bundle.actions.length),
    tags: rows(outputs, "tags", length, bundle.tags.length),
    enums: Object.fromEntries(Object.entries(bundle.enums).map(([key, values]) => [key, vector(outputs, `enum_${key}`, values.length)])),
    segment: bundle.hasSegmentHead ? rows(outputs, "segment", length, SEGMENT_WIDTH) : null,
  };
  const aux = Object.entries(bundle.aux);
  const withAux = aux.length ? { ...heads, aux: Object.fromEntries(aux.map(([name, labels]) => [name, vector(outputs, `aux_${name}`, labels.length)])) } : heads;
  const lists = Object.entries(bundle.listHeads);
  return lists.length ? { ...withAux, lists: Object.fromEntries(lists.map(([key, values]) => [key, vector(outputs, `list_${key}`, values.length)])) } : withAux;
}
