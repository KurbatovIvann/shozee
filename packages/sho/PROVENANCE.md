# Provenance

**Internal and proprietary.** The Шо model weights, tokenizer, labels and the
`@sho/runtime` decoder are confidential assets of the Шозі (Shozee) project.
They run only on our servers and are never shipped to browsers, mobile clients,
or any public artifact. `@showzy/sho` is imported by `apps/sho` alone
(ADR-0051); the schemas both sides share live in `@showzy/sho-protocol`.

## Source

- Repository: `system-one-uk` (local checkout), commit
  `c1e1d8547e7bae9ce0fb2ef55f1d655dfcdab932` (D88-D92: a stateless `focus`,
  new need reasons, `capabilities.fiscal`, `run({text})` refusing
  unnormalised text with `text_not_normalised`, and an `orders.update` that
  names no order read as `orders.create`. D93: an utterance with letters and
  no Cyrillic word is not run through the model — one `none` command with the
  need reason `language` and confidence 0, for the host's dialogue model — and
  a `path: "action"` `unsupported` need declines an object ШО does not handle.
  D94: a phone or an e-mail said for a customer is the `customer` ref
  `{status, by, value}`, `unchecked` unless the context carries contacts, and
  a find worded as a create is served as `customers.getCustomer` with the need
  reason `read_as_find`). Vendored from `git archive`, not the working tree.
- Runtime: `runtime/src` of `@sho/runtime` 0.2.0 without `src/cli`, copied byte
  for byte into `runtime/src`. Its `package.json` was not copied: it declares a
  `bin` pointing at the `src/cli` we deliberately left out, and `@showzy/sho`
  owns the `onnxruntime-node` dependency. The upstream `runtime/test` suites
  were not copied either: the v3 conformance vectors below exercise the same
  decoder against pinned expectations.
- Model: `v33` (catalogue `v3`, registry status `default` in `models.json`),
  bundle `demo/model-v33`, copied into `model/v33/`. The fp32 `model.onnx` is
  not copied. The model is unchanged by this re-vendor: the three md5s below
  are still the ones `models.json` records for `v33` at the commit above, and
  `v33` is still its `default`.
- Requirements: the runtime's `loadRequirements` reads the bundle's
  `intent_labels_uk.json` (each action's `required` params and `one_of` group,
  for the `missing` needs). That file is frozen with the `v33` weights and is
  a snapshot of the v3.3 catalogue; the conformance vectors are served with
  the catalogue itself, `data/voice2/catalogue_v3.json` at the commit above,
  copied into `test/conformance-v3/catalogue_v3.json`. Since D94 the two
  differ on `customers.getCustomer`: the catalogue takes one of `customer`,
  `phone`, `email`, the frozen snapshot requires `customer`, so a host on the
  `v33` bundle still sees `{path: "customer", reason: "missing"}` there.
- Calibration: the bundle's `calibration.json`; `loadSho` passes its action
  temperature to the runtime (`RuntimeOptions.actionTemperature`), so
  `confidence` is calibrated.
- Conformance: `conformance/v3/` (35 files) copied byte for byte into
  `test/conformance-v3/`, plus the catalogue above as a 36th file;
  `test/conformance-v3.test.ts` decodes all 514 `commands.jsonl` vectors, the
  46 `focus.jsonl` vectors (D88-D92, bound through `withFocus` and
  `withCreates`) and the 13 `contacts.jsonl` vectors (D94, against
  `labels-v35.json`: today's v3 labels with `phone` and `email` on
  `customers.getCustomer`, as a v3.5 bundle will carry them) with the
  vendored runtime.

## Files

`model.int8.onnx`, `tokenizer.json` and `labels.json` match the md5 recorded for
model `v33` in the checkout's `models.json`, and `model.int8.onnx` its
`size_bytes`.

- `model.int8.onnx`: md5 `f10ddb141facf18a42a69769e59c099c`, 28740435 bytes.
- `tokenizer.json`: md5 `b7943c0e6e335439c0b8df6590bf76df`, 1039303 bytes.
- `labels.json`: md5 `e3268c5d8783656973ad1839038b158c`, 31931 bytes.
- `intent_labels_uk.json`: md5 `58ea7db7b3f43438b5e7beed827705ce`, 177584 bytes.
- `calibration.json`: md5 `46ee35fe0cbcbc13344596ca7f898794`, 307 bytes.

`manifest.json` holds the same hashes, one per vendored `runtime/src` file, and
those of the conformance files; `loadSho` hashes the bundle and the runtime
sources against it on every load unless the caller passes `verify: false`, and
`test/manifest.test.ts` fails if a committed file differs from it. Updating the
bundle means re-copying from the source checkout and regenerating
`manifest.json`; `runtime/`, `model/` and `test/conformance-v3/` are excluded
from Prettier, ESLint and the comment gate because they are vendored verbatim.
