# Provenance

**Internal and proprietary.** The Шо model weights, tokenizer, labels and the
`@sho/runtime` decoder are confidential assets of the Шозі (Shozee) project.
They run only on our servers and are never shipped to browsers, mobile clients,
or any public artifact.

## Source

- Repository: `system-one-uk` (local checkout), commit
  `d8e39dadceb2986308c66c96fad3138f96d67ab8`.
- Runtime: `runtime/src` of `@sho/runtime` 0.2.0 without `src/cli`, copied byte
  for byte into `runtime/src`. Its `package.json` was not copied: it declares a
  `bin` pointing at the `src/cli` we deliberately left out, and `@showzy/sho`
  owns the `onnxruntime-node` dependency. The upstream `runtime/test` suites
  were not copied either: the v3 conformance vectors below exercise the same
  decoder against pinned expectations.
- Model: `v33` (catalogue `v3`, registry status `default` in `models.json`),
  bundle `demo/model-v33`, copied into `model/v33/`. The fp32 `model.onnx` is
  not copied.
- Requirements: the runtime's `loadRequirements` reads the bundle's
  `intent_labels_uk.json` (each action's `required` params and `one_of` group,
  for the `missing` needs).
- Calibration: the bundle's `calibration.json`; `loadSho` passes its action
  temperature to the runtime (`RuntimeOptions.actionTemperature`), so
  `confidence` is calibrated.
- Conformance: `conformance/v3/` (20 files) copied byte for byte into
  `test/conformance-v3/`; `test/conformance-v3.test.ts` decodes all 478 vectors
  with the vendored runtime.

## Files

`model.int8.onnx`, `tokenizer.json` and `labels.json` match the md5 recorded for
model `v33` in the checkout's `models.json`, and `model.int8.onnx` its
`size_bytes`.

- `model.int8.onnx`: md5 `f10ddb141facf18a42a69769e59c099c`, 28740435 bytes.
- `tokenizer.json`: md5 `b7943c0e6e335439c0b8df6590bf76df`, 1039303 bytes.
- `labels.json`: md5 `e3268c5d8783656973ad1839038b158c`, 31931 bytes.
- `intent_labels_uk.json`: md5 `58ea7db7b3f43438b5e7beed827705ce`, 177584 bytes.
- `calibration.json`: md5 `46ee35fe0cbcbc13344596ca7f898794`, 307 bytes.

`manifest.json` holds the same hashes and those of the conformance files;
`test/manifest.test.ts` fails if a committed file differs from it. Updating the
bundle means re-copying from the source checkout and regenerating
`manifest.json`; `runtime/`, `model/` and `test/conformance-v3/` are excluded
from Prettier, ESLint and the comment gate because they are vendored verbatim.
