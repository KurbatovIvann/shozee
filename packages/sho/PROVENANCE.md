# Provenance

**Internal and proprietary.** The Шо model weights, tokenizer, labels and the
`@sho/runtime` decoder are confidential assets of the Шозі (Shozee) project.
They run only on our servers and are never shipped to browsers, mobile clients,
or any public artifact. `@showzy/sho` is imported by `apps/sho` alone
(ADR-0051); the schemas both sides share live in `@showzy/sho-protocol`.

## Source

- Repository: `system-one-uk` (local checkout), commit
  `d85704f36f0853e55d5e89eeb577f3096a24fd70` (D95: an order said after
  «і зроби» is re-read as a second command with `refPrevious` instead of being
  lost, an `unparsed` need over words that hold a product the command does not
  is blocking on a write or a delete, a name said after a bare «клієнту» is the
  `customer` of an action over the customer, and a write whose only customer
  words are that bare «клієнту» asks a plain `missing`. D96: v3.5 (`v35`) is the
  owner's default bundle. D97: a question about the app itself — «як мені
  додати …», «що таке …», «де в застосунку …» — is `none` with the new
  non-blocking need reason `how_to`, which the host routes to its dialogue
  model exactly as it routes `language`, never as a low confidence).
  Vendored from `git archive`, not the working tree.
- Runtime: `runtime/src` of `@sho/runtime` 0.2.0 without `src/cli`, copied byte
  for byte into `runtime/src`. Its `package.json` was not copied: it declares a
  `bin` pointing at the `src/cli` we deliberately left out, and `@showzy/sho`
  owns the `onnxruntime-node` dependency. The upstream `runtime/test` suites
  were not copied either: the v3 conformance vectors below exercise the same
  decoder against pinned expectations.
- Model: `v35` (catalogue `v3`, registry status `default` in `models.json`),
  bundle `demo/model-v35`, copied into `model/v35/`. The fp32 `model.onnx` is
  not copied. `v33` is retired from this package; `models.json` keeps it
  `available` upstream.
- Requirements: the runtime's `loadRequirements` reads the bundle's
  `intent_labels_uk.json` (each action's `required` params and `one_of` group,
  for the `missing` needs). The v3.5 snapshot carries D94, so it no longer
  diverges from the catalogue the vectors are served with,
  `data/voice2/catalogue_v3.json` at the commit above, copied into
  `test/conformance-v3/catalogue_v3.json`:
  `test/conformance-v3.test.ts` asserts the set of actions the two disagree on
  is empty, which is what keeps a host on the shipped bundle from seeing a need
  the catalogue does not describe.
- Calibration: the bundle's `calibration.json`, action temperature `0.638`
  (v3.3 had `0.646`); `loadSho` passes it to the runtime
  (`RuntimeOptions.actionTemperature`), so `confidence` is calibrated. The
  "not confident" threshold is unchanged at 0.95 calibrated.
- Conformance: `conformance/v3/` (36 files) copied byte for byte into
  `test/conformance-v3/`, plus the catalogue above as a 37th file;
  `test/conformance-v3.test.ts` decodes all 521 `commands.jsonl` vectors, the
  46 `focus.jsonl` vectors (D88-D92, bound through `withFocus` and
  `withCreates`) and the 13 `contacts.jsonl` vectors (D94, against
  `labels-v35.json`, the vectors' own copy of the v3.5 contact labels) with the
  vendored runtime.

## Files

`model.int8.onnx`, `tokenizer.json` and `labels.json` match the md5 recorded for
model `v35` in the checkout's `models.json`, and `model.int8.onnx` its
`size_bytes`; all five match the table in the Shozee handover §D96.

- `model.int8.onnx`: md5 `09435500d21e44536daf87c12aa57a62`, 28755698 bytes.
- `tokenizer.json`: md5 `7d098a6442843ea95b28e43a904f78bc`, 1039101 bytes.
- `labels.json`: md5 `d8596295b99528f0d03fc801710b3315`, 30341 bytes.
- `intent_labels_uk.json`: md5 `ecca9fa43654b05efe6acfdfb584284d`, 177535 bytes.
- `calibration.json`: md5 `a298b87895edb334dc6f5122071ffafe`, 307 bytes.

`manifest.json` holds the same hashes, one per vendored `runtime/src` file, and
those of the conformance files; `loadSho` hashes the bundle and the runtime
sources against it on every load unless the caller passes `verify: false`, and
`test/manifest.test.ts` fails if a committed file differs from it. Updating the
bundle means re-copying from the source checkout and regenerating
`manifest.json`; `runtime/`, `model/` and `test/conformance-v3/` are excluded
from Prettier, ESLint and the comment gate because they are vendored verbatim.
