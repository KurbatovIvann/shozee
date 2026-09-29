export function softmax(values: ArrayLike<number>): number[] {
  const list = Array.from(values);
  const top = Math.max(...list);
  const exps = list.map((value) => Math.exp(value - top));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((value) => value / sum);
}

export function argmax(values: ArrayLike<number>): number {
  let best = 0;
  for (let index = 1; index < values.length; index++) if ((values[index] ?? Number.NaN) > (values[best] ?? Number.NaN)) best = index;
  return best;
}
