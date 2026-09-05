# T2 — Signing and encryption for tax filing

**Status:** crypto requirements established; a real gap found in our package · [SHO-445](https://linear.app/showzy-v2/issue/SHO-445)

Step 4 of `target-flow.md`. Two owner decisions already narrowed this
topic: the human signs and we transmit, and phase 1 supports the **file
key only**. What remains is what the tax side demands around that
signature — and that turns out to be more than signing.

---

## The finding: filing needs encryption, and we do not have it

`packages/document-signing` signs. It does not encrypt.

Its exports are `DocumentSigner` with `SignOptions`, `SignResult`,
`VerifyResult`, ASiC-E container assembly, a ЦЗО CA registry with
CMP/OCSP/TSA, and DSTU algorithm OIDs. There is no envelope, no recipient
certificate, no symmetric encryption — nothing that produces a block
encrypted *to* someone.

But наказ 499 requires exactly that: the message we send is a data block
**encrypted to the recipient**, and every reply is a block **encrypted to
the payer**. Encryption is not optional decoration around the signature;
it is the container.

> **S:** `packages/document-signing/src/index.ts` and a search of the package for encryption primitives, 2026-09-05; requirement from наказ 499 §5.3
> **V:** verified in our own code
> **C:** high

This is the single most important thing this topic has produced. The
existing package was carried over for **document signing** (ADR-0012),
which is a genuinely different job from **document exchange with the tax
authority**. Reusing it is still right; assuming it already covers filing
is not.

## What the tax side requires cryptographically

Наказ 499 §2 names three standards and one condition:

| Purpose | Standard |
| --- | --- |
| Signature creation and verification | **ДСТУ 4145-2002** |
| Key agreement / open key distribution | **ДСТУ ISO/IEC 15946-3:2006** |
| Symmetric encryption | **ГОСТ 28147-89** |

and the means of cryptographic protection must be **certified under
Ukrainian law**.

> **S:** наказ 499 §2 — sources.md#order-499, read 2026-09-05
> **V:** desk-only (primary text)
> **C:** high

### What we already have

Signing is covered. `pki/algorithms.ts` carries `OID_DSTU4145_GOST_PB`,
`OID_DSTU4145_WITH_GOST3411`, `OID_GOST34311` and the Kupyna variants, and
the package signs with them through UAPKI on all three platforms
(`platform/node-adapter.ts`, `web-adapter.ts`, `native-adapter.ts`) with
fixture tests against both GOST and Kupyna. ДСТУ 4145-2002 is the standard
those OIDs implement, so requirement one is met by existing, tested code.

### What is missing — from the TypeScript layer only

Key agreement per ДСТУ ISO/IEC 15946-3 and symmetric encryption per ГОСТ
28147-89 do not appear anywhere in our TypeScript. But the crypto is
already in the box.

## Verified: the engine can already do this

The vendored UAPKI (upstream `specinfo-ua/UAPKI`, tag **v2.0.16**,
`UAPKI-VENDOR.md`) implements all three required standards, and our build
already compiles them.

> **S:** the vendored source in `packages/document-signing/cpp/`, read 2026-09-05
> **V:** verified in our own tree
> **C:** high — read from the source and the build files, not from documentation

| Requirement | Where it lives | Status |
| --- | --- | --- |
| ДСТУ 4145-2002 signature | `cpp/uapkic/src/dstu4145.c` | in use today |
| ГОСТ 28147-89 encryption | `cpp/uapkic/src/gost28147.c`; OIDs `OID_GOST28147_CFB`, `OID_GOST28147_WRAP` and others in `cpp/common/pkix/oids.h` | compiled, unused |
| ДСТУ ISO/IEC 15946-3 key agreement | Diffie-Hellman KDFs in `cpp/uapki/src/api/encrypt.cpp` — `OID_STD_DH_GOST34311_KDF`, `OID_COFACTOR_DH_GOST34311_KDF`, and the DSTU 7564 pair | compiled, unused |

`ENCRYPT` and `DECRYPT` are registered in the JSON API dispatch table
(`cpp/uapki/src/api/api-json.cpp`) alongside `SIGN` and `VERIFY`, and
`cpp/uapki/CMakeLists.txt` compiles the API directory wholesale
(`aux_source_directory(${PATH_PRJ}/src/api ...)`). **They are already inside
the WASM and Nitro binaries we ship.**

### And our adapter can already reach them

`UapkiAdapter.process(jsonRequest: string)` is a **generic JSON
pass-through** — `UapkiRequest` is just `{method, parameters}`. The
existing calls (`INIT`, `KEYS`, `SELECT_KEY`, `ADD_CERT`, `SIGN`,
`VERIFY`, `DEINIT`) use the same door that `ENCRYPT` and `DECRYPT` use.

So no C++ change, no WASM rebuild, no Nitro codegen, no adapter change.
The gap is a TypeScript calling layer over capability that is already
shipped on all three platforms.

### What ENCRYPT actually produces

It builds a CMS **EnvelopedData**:

```
parameters: {
  content:           { bytes, encryptionAlgo, encryptionAlgoParams?, type? }
  recipientInfos:    [ { certId, kdfAlgo, keyWrapAlgo } ]
  originatorCertIds: [ ... ]
  unprotectedAttrs:  [ ... ]
}
→ result: { bytes }   // encoded EnvelopedData
```

Only `KeyAgreeRecipientInfo` is supported — the recipient certificate must
carry the `keyAgreement` key usage — which is the right and expected shape
for the DSTU scheme.

**One trap:** `encryptionAlgo` defaults to DSTU 7624 (Kalyna) CFB. Наказ
499 specifies ГОСТ 28147-89. We must set the algorithm and the KDF
explicitly and never rely on the defaults.

## The signature-format legal chain, and why our code is already right

The joint Мін'юст / Держспецзв'язку order of 2012-08-20 № 1236/5/453 —
the one the ДПС `CERTYPE` notice cites — set the ЕЦП-era requirements for
certificate format, signed-data format, timestamping and OCSP. **It is
repealed**, and so is each successor: `z1398-12` → `z1172-19` (2020) →
`z1039-20` (2020) → `z0375-24` (2024), and that last one only repeals.
Requirements now live in **ПКМУ 28.06.2024 № 764**.

> **S:** repeal chain read directly from `zakon.rada.gov.ua`, 2026-09-05
> **V:** desk-only
> **C:** high

One thing from the repealed order is still worth knowing, because it
describes a real transition: ДСТУ 4145-2002 with the **ГОСТ 34.311-95**
hash applied to signature *creation* until 2022-01-01, and with **ДСТУ
7564-2014 (Купина)** from that date onward.

**Our code handles this correctly and needs no change.**
`signingAlgosFromCertAlgorithm` in `pki/algorithms.ts` derives the pair
**from the signer's own certificate**: an algorithm OID under
`1.2.804.2.1.1.1.1.3.6` selects the Kupyna pair, anything else the GOST
pair. There is no hardcoded default and no date logic — it follows the key,
which is the only correct behaviour when both eras coexist.

And they do coexist: ДПС's own 2025 technological certificates are signed
with the **GOST-hash variant** (`1.2.804.2.1.1.1.1.3.1.1`). So the GOST
path is not legacy-only in 2026, and removing it would break verification
against the authority's own certificates.

## The taxpayer has two keys, and we already skip one

A ФОП key container holds **two keys**: one labelled «підпис» and one
labelled «шифрування», issued together by their КНЕДП.

> **S:** the owner's КЕП key manager — sources.md#owner-kep-keys, 2026-09-05
> **V:** observed
> **C:** high

That is not incidental. Filing needs both:

- the **signature** key signs the declaration;
- the **encryption** key is the taxpayer's side of the key agreement, and
  it is what decrypts the receipts that come back encrypted to them.

Our code already knows the distinction. `findSigningKey` in
`document-signer.ts` selects on exactly these labels:

```ts
keys.find((k) => k.label?.includes("підпис")) ??
keys.find((k) => !k.label?.includes("шифрування")) ??
keys[0]
```

It finds the signing key and deliberately steps over the encryption one.
`KEYS` already lists both, and the storage is already open when it does.

So the encryption key needs no new discovery mechanism — it needs a
sibling selector and a second `SELECT_KEY`. That is a smaller change than
anything else on this card.

### But whether we need it at all depends on the channel

Refined 2026-09-05. The two uses of the encryption key are not equally
unavoidable:

- **Encrypting our submission to ДПС** — unavoidable. The наказ 499
  container is a block encrypted to the authority, and the recipient there
  is a *published* ДПС certificate. This needs `ENCRYPT`, but it does
  **not** need the client's private key: encrypting to someone uses their
  public certificate. Only the key agreement's originator side involves
  our signer, and that happens where the owner already is.
- **Decrypting receipts** — avoidable. Receipts arrive encrypted to the
  payer only on the Єдине вікно channel, and decrypting them requires the
  client's *private* key, repeatedly, long after signing. The cabinet REST
  API sidesteps it entirely by serving receipts already decrypted
  (`reporting-api.md`).

A third-party product on the Єдине вікно channel prompts for the
encryption key when a user opens a receipt — observed 2026-09-05. That is
the cost of that channel, and it is a cost our architecture should decline.

**Consequence:** if filing goes through the cabinet API, the client's
private key is needed exactly once per declaration — to sign — and never
again. That is the property `target-flow.md` step 4 assumed, and it
survives only on that channel.

## How our existing container work relates — and one concrete correction

Worth comparing directly, because the answer is "not at all" at one layer
and "exactly" at the layer below.

### The formats are unrelated

`asic-container.ts` builds **ASiC-E**: a ZIP whose first entry is
`mimetype`, STORED and uncompressed with an empty extra field per ETSI TS
102 918, followed by the payload, a manifest and signatures. A European
standard container with a ZIP structure.

The наказ 499 container is a hand-rolled binary frame — a `TRANSPORTABLE`
header of `<Tag>=<Value>` lines, then blocks of
`signature · 0x00 · 4-byte length · payload`. Nothing about the ZIP packer
transfers. The tax container has to be written from scratch.

### The payloads inside are exactly what we already produce

Our `SIGN` call returns `p7sBase64` — a CMS SignedData. Наказ 499 describes
the `XXX_SIGN` block as holding «буфер підпису **та підписаних даних**».
`ENCRYPT` returns a CMS EnvelopedData, the natural candidate for
`XXX_CRYPT`'s «зашифрований документ».

The order is from 2010 and describes both abstractly, but the libraries
Ukrainian CAs actually ship produce precisely these two CMS structures. So
the components are already in hand; only the framing is missing.

**Settled 2026-09-05, after one wrong turn.** An intermediate reading of
наказ 485 (2008) suggested `UA1_CRYPT` held raw ГОСТ 28147-89 ciphertext,
because that text puts the session key and IV in the header requisites.
That was correct about the **pre-2012** container and wrong about today:
the 2012 joint order on new formats replaced it, and the same change turned
`CERTYPE` from a per-CA letter into the constant `UA1`.

A working implementation confirms the current shape — the crypt block
carries the output of an `EnvelopData()` call, i.e. a **CMS envelope**.
Detail in `reporting-api.md`.

So the mapping is symmetric, and both halves are what we already produce:

| Block | Content | Our source |
| --- | --- | --- |
| `UA1_SIGN` | CMS SignedData, **attached** | `SIGN` with `detachedData: false` |
| `UA1_CRYPT` | CMS EnvelopedData | `ENCRYPT`, recipient = ДПС encryption certificate |

**`ENCRYPT` is the right entry point.** No lower-level primitives, no
hand-built key agreement — the two UAPKI methods already compiled into our
binaries produce exactly the two payloads the container wants.

The reference implementation independently confirms the attached-signature
point: it calls the library's `SignDataInternal(true, …)`, where "internal"
means the signed data travels inside the signature — the same conclusion
the `detachedData` correction above reached from the наказ's wording.

Also observed there: the 4-byte block length is **little-endian**.

### The correction

```ts
detachedData: options.isDetached ?? true    // our default
```

Наказ 499 says the block holds the signature **and the signed data**. That
is an **attached** signature. Our default is detached.

For tax filing the flag has to be inverted. A small thing, and exactly the
kind that surfaces as an opaque rejection months later if nobody writes it
down now.

Two related defaults to revisit at the same time: `signatureFormat` is
`CAdES-XL` (with revocation material embedded), and `includeContentTs` is
false while the container has a separate `XXX_STAMP` block for timestamps.
Which CAdES level the tax side expects, and whether the timestamp belongs
inside the signature or in its own block, are open.

## What the remaining work actually is

Not cryptography. Three concrete pieces:

1. **A TypeScript surface for `ENCRYPT`/`DECRYPT`** on `DocumentSigner` or
   a sibling, mirroring how signing is already exposed.
2. **Fetching, caching and `ADD_CERT`-ing the ДПС encryption certificate**,
   then using its `certId` as the recipient — with rotation handled, as
   below.
3. **Assembling the наказ 499 binary container** around the crypto output.
   This is the genuinely new part: the container is a custom framing
   (`XXX_CRYPT`, `XXX_SIGN`, `XXX_STAMP` blocks with a `TRANSPORTABLE`
   header), not a standard envelope. UAPKI gives us the cryptographic
   payloads; the framing is ours to write.

That reorders the risk. The cryptography was the scary part and it is
solved. What is left is byte-level assembly against a specification whose
worked examples were never published — which is fiddly, testable, and
exactly the kind of thing one real container from the cabinet would pin
down in an afternoon.

## The certificates to encrypt to

**Correction, 2026-09-05.** The cabinet URLs quoted in the ДПС press
release — `cabinet.tax.gov.ua/cabinet/resources/js/sign/data/EK_*.cer` —
**return 404 today.** The cabinet has been rebuilt as a hashed-bundle
Angular application and that resource path is gone. A press release is not
a durable location for a machine-readable artefact.

The durable source is the **«Єдина адреса»** page on the ДПС portal:
`tax.gov.ua/elektronna-zvitnist/platnikam-podatkiv-pro/edina-adresa/`. It
carries every certificate generation, current and historical, as direct
downloads.

### There are two separate sets, and the naming is a trap

| Channel | Signing ДПС's messages to us | **Encrypting our messages to ДПС** |
| --- | --- | --- |
| Єдине вікно (the email channel) | `STS_2025_1.cer` | `STS_2025_2.cer` |
| **API Електронного кабінету** | `EK_S_NEW_2025_1.cer` | `EK_S_NEW_2025_2.cer` |

The REST filing integration uses the **`EK_*` pair** — those are the
technological certificates of the cabinet API. The `STS_*` pair belongs to
the Єдине вікно channel, which is what the observed third-party filing went
through.

The trap: the previous generation was named by function — `EK_S_NEW.cer`
for signing, `EK_C_NEW.cer` for crypt. The 2025 generation dropped that and
uses `_1` / `_2` on an `EK_S_NEW_` stem, so **both current API certificates
begin with `EK_S`** and the filename no longer says which is which.

### Verified by downloading and parsing them

Both `EK_*` certificates were fetched and parsed on 2026-09-05. The
`KeyUsage` extension settles it, and it is the only thing that does:

| File | `KeyUsage` (critical) | Actual purpose |
| --- | --- | --- |
| `EK_S_NEW_2025_1.cer` | `DigitalSignature, NonRepudiation` | **signing** |
| `EK_S_NEW_2025_2.cer` | `KeyAgreement` | **encryption** |

Both share subject CN «Державна податкова служба України. "ОТРИМАНО ЕК"»,
issued by КНЕДП ДПС, valid **2025-07-30 → 2027-07-29 23:59:59Z**.

> **S:** the certificates themselves, downloaded from sources.md#dps-edina-adresa and parsed
> **V:** **verified** — X.509 parsed, extensions read
> **C:** high

Three things follow.

1. **Select the recipient certificate by `KeyUsage`, never by filename.**
   The names have already changed once and stopped being descriptive; the
   extension is authoritative and stable.
2. **`KeyAgreement` is exactly what UAPKI requires.** `encrypt.cpp` checks
   `cerRecipient.keyUsageByBit(KeyUsage_keyAgreement)` before building a
   `KeyAgreeRecipientInfo`. This certificate passes that check, so the
   recipient side of `ENCRYPT` works with it as-is.
3. **The rotation deadline is a known date.** These expire 2027-07-29, so
   the next generation must be in place before then — consistent with the
   ~2-year cadence visible in the page's history.

The certificates also carry the CA's service endpoints, which we need
anyway: OCSP at `ca.tax.gov.ua/services/ocsp/`, **TSP at
`ca.tax.gov.ua/services/tsp/`** (relevant to the container's `XXX_STAMP`
block), CRL and delta-CRL under `ca.tax.gov.ua/download/crls/`, and the CA
bundle `allacskidd-2022.p7b`.

### Rotation cadence is roughly two years

The page keeps the full history: 2014 (Міндоходів), 2018, 2019, 2021,
2023, **2025**. Each generation is a new pair with a new filename, and the
old ones stay published. So this is not an unpredictable event — the next
rotation is due around 2027, and it will appear on this page as a new
named pair rather than as a changed file at a stable URL.

That changes the implementation slightly for the better: we are not
watching one URL for changed bytes, we are watching one page for a new
generation. Our `pki/ca-registry.ts` pattern still applies — runtime fetch,
lenient parse — but the discovery step is a page, not a file.

### These rotate, and that is an operational obligation

The current certificates took effect at 09:00 on 2025-08-06, replacing
the previous ones, and the announcement explicitly addresses software
developers. The `_NEW` suffix in the filenames is itself a warning: the
URL is stable while its content changes.

So a filing integration has to treat the ДПС certificate as **refreshable
configuration, not a build-time constant**, and has to notice a rotation
before a submission fails. This is the same shape of problem as form
versions in `reporting-api.md`, and probably wants the same answer: watch
the source.

Our `pki/ca-registry.ts` already does exactly this pattern for the ЦЗО
registry — it downloads `CAs.json` and a CA bundle at runtime, parses
leniently, and skips malformed entries. That is a working precedent to
copy rather than a new problem.

## What phase 1 signing does not need

By owner decision, phase 1 is the **file key** only, using capability the
platform already has on web and mobile. Дія.Підпис, hardware tokens,
cloud signature and monoКЕП are later.

Worth restating because it bounds this topic: **no new signing UX is in
scope.** What is in scope is what happens to the signed bytes afterwards.

## Open questions

1. ~~Does UAPKI expose the missing primitives, and can our adapters reach
   them?~~ **Answered: yes to both.** Verified in the vendored source —
   `ENCRYPT`/`DECRYPT` are in the JSON dispatch table, the API directory is
   compiled wholesale into our WASM and Nitro builds, GOST 28147 and the
   DH KDFs are present, and the adapter is a generic JSON pass-through. No
   C++, WASM, Nitro or adapter work. See the verification section above.
2. **Which certified СКЗІ satisfies "certified under Ukrainian law"**, and
   does our UAPKI-based stack qualify for tax filing specifically? A
   library that signs correctly is not automatically an accepted means of
   protection.
3. **What is our `CERTYPE` letter?** The container tags every block with a
   letter identifying the CA whose library produced it. What a
   UAPKI-based integration puts there is not obvious, and the field is
   mandatory.
4. ~~How does a ФОП signature map onto the mandated order?~~ **Answered
   from a real filing**: квитанція №1 records it as «перший - директор» —
   the single signature occupies the **director** slot. See
   `reporting-api.md`.
5. **Receipts come back encrypted to the payer.** Decrypting them needs the
   client's key. If our server is to act on a receipt's status
   automatically, either the key participates again or something else has
   to. This may be the strongest constraint in the whole flow — see
   `reporting-api.md` open question 9.
6. **May we store the signed and encrypted payload**, and for how long? It
   is the evidence a return was filed.
9. **How long does a signed `Authorization` value stay valid?** It is a
   constant for a given key and certificate — the signed payload is just
   the taxpayer's identifier, with no timestamp or nonce — so it is
   replayable by construction and only a server-side expiry can limit it.
   The answer sets how often the owner must re-authorise, and it is the
   remaining unknown in the unattended-filing story. See `reporting-api.md`.
10. **Where does that value live in our system?** A replayable
    `Authorization` is a long-lived bearer credential for the taxpayer's
    entire cabinet — registration card, bank accounts, settlement state,
    filed documents. It needs credential-grade handling, not cache-grade.
    The owner's key never reaches us; this derived value would. That is a
    smaller exposure than a key and still a serious one.
7. Is a TSA timestamp required on a filing signature, or only when
   `GET_STAMP=1` requests one in the reply?
8. ~~Is the `UA1_CRYPT` payload a CMS EnvelopedData or a raw blob?~~
   **Answered: a CMS envelope.** A working implementation builds the block
   from an `EnvelopData()` call, so UAPKI's `ENCRYPT` is the right entry
   point. Confidence medium-high — it is a third-party implementation
   rather than an official spec, and it diverges from наказ 499 in a few
   header tags. Worth confirming against a real accepted container, but no
   longer a blocker.

## Note on ADR-0012

ADR-0012 carried over the QES core "unchanged" and re-audited only the
integration surface. That decision now looks better than it did when it
was made: the carried-over core turns out to contain the encryption
capability tax filing needs, years before anyone asked for it.

Tax filing still adds a foreign container format to the package's remit,
but it no longer adds cryptography. That is a smaller question than it
looked an hour ago, and probably does not need an ADR of its own — the
container assembly is ordinary code, not an architectural commitment.
