import { ModelError } from "../errors.ts";
import type { ModelRunner, RawOutputs, RawTensor } from "../model.ts";

export interface OrtTensorLike {
  readonly data: unknown;
  readonly dims: readonly number[];
}

export interface OrtSessionLike {
  run(feeds: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, OrtTensorLike>>>;
  release?(): Promise<void>;
}

export type OrtTensorConstructor = new (type: "int64", data: BigInt64Array, dims: readonly number[]) => unknown;

function rawTensor(name: string, tensor: OrtTensorLike): RawTensor {
  if (!(tensor.data instanceof Float32Array)) throw new ModelError("output_type", `${name} is not a float32 tensor`);
  return { data: tensor.data, dims: Array.from(tensor.dims) };
}

export function ortRunner(Tensor: OrtTensorConstructor, session: OrtSessionLike): ModelRunner {
  return {
    async run(ids) {
      const shape = [1, ids.length];
      const feeds = {
        input_ids: new Tensor("int64", BigInt64Array.from(ids, (id) => BigInt(id)), shape),
        attention_mask: new Tensor("int64", BigInt64Array.from(ids, () => 1n), shape),
      };
      const outputs = await session.run(feeds);
      const raw: RawOutputs = Object.fromEntries(Object.entries(outputs).map(([name, tensor]) => [name, rawTensor(name, tensor)]));
      return raw;
    },
    async dispose() {
      await session.release?.();
    },
  };
}
