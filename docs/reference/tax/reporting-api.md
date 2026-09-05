# T4 — Reporting: filing the single-tax declaration

**Status:** first pass complete; the load-bearing question is answered · [SHO-447](https://linear.app/showzy-v2/issue/SHO-447)

Steps 3 and 5 of `target-flow.md`. Claim discipline in `README.md`.

---

## The answer we needed: a submission API exists

T4's dominant question was whether anything accepts a signed declaration
from a third-party system, or whether the human has to upload it in the
cabinet themselves. **It does.** ДПС documents a public REST API for
submitting reports.

- **Host:** `https://cabinet.tax.gov.ua`
- **Base path:** `/cabinet/public/api/exchange`

| Purpose | Method | Path |
| --- | --- | --- |
| Submit a report | POST | `/report` |
| Submit a package of reports | POST | `/reportzip` |
| Fetch receipts | POST | `/kvt_by_id` |
| Bank account open/close notices | POST | `/reportBank` |

`/report` takes an array of `InReportDao` — `{contentBase64, fname}`.
`/reportzip` takes `zipBase64`. `/kvt_by_id` takes `encryptedId`. JSON in,
JSON out. Documented responses: 200 OK, 201 Created, 401, 403, 404.

> **S:** ДПС, «Опис API Електронного кабінету» — sources.md#dps-cabinet-api, read 2026-09-05
> **V:** desk-only (official documentation on the authority's own site, not exercised)
> **C:** high

Step 5 of the flow therefore works as designed: the owner signs, we
transmit.

## What actually goes over the wire: the наказ 499 container

`contentBase64` is not the declaration. It is the declaration XML signed,
encrypted, and wrapped in a binary transport container defined by **наказ
ДПА України від 12.07.2010 № 499**. `fname` is named per наказ Міндоходів
від 29.11.2013 № 729.

The order has never been amended — the version in force is the original
2010 text. A format frozen for sixteen years is stable to build against,
and it shows: this is a hand-rolled binary envelope, not a standard one.

> **S:** наказ ДПА 12.07.2010 № 499, «Уніфікований формат транспортного повідомлення» — sources.md#order-499, primary text read 2026-09-05
> **V:** desk-only (primary text, in full)
> **C:** high for the structure; the worked examples are missing — see the gap below

### Two things named "transport", only one of which we need

Section 4 describes a **transport message**: a MIME file per RFC 1521 —
literally an email, with `From`, `Reply-To`, `To`, `Message-ID`, the
container as an `application/octet-stream` attachment, Windows-1251
encoding, max 10 MB, one container per message. That is the email channel
to the "єдина адреса".

Section 5 describes the **transport container** itself. The cabinet REST
API takes the container, not the MIME wrapper — `contentBase64` is section
5, and section 4 is irrelevant to us. Easy to conflate, expensive to get
wrong.

### Block format

Every block is a signature string, a zero byte, a 4-byte length, then
payload:

| Block | Layout |
| --- | --- |
| `XXX_CRYPT` | signature · `0x00` · 4-byte size · encrypted document |
| `XXX_SIGN` | signature · `0x00` · 4-byte size · buffer of signature and signed data |
| `XXX_STAMP` | signature · `0x00` · 4-byte hash size · hash of the original document · 4-byte stamp size · timestamp buffer · 4-byte size · the stamped data block |

`XXX` is a **letter code identifying the certification authority** whose
crypto library produced the block — "A" for the first CA accredited in
Ukraine, "B" for the second, and so on down the Latin alphabet. A 2010
design decision that is still load-bearing: the same letter goes in the
header's `CERTYPE` tag, so we have to know which letter our signing stack
claims. Open question 7.

Timestamps come from the CA over TSP.

### Container header

Signature `TRANSPORTABLE`, a zero byte, a 4-byte header length excluding
the signature and zero byte, `CRLF`, then `<Tag>=<Value>` lines each
terminated by CR+LF, all in Windows-1251.

| Tag | Required | Meaning |
| --- | --- | --- |
| `FILENAME` | yes | file name, uppercase |
| `RCV_EMAIL` | yes | recipient e-mail |
| `PRG_TYPE` | yes | name of the software that applied the signature, ≤10 chars |
| `SND_DATE` | yes | `YYYYMMDDHHNNSS`, no separators |
| `CERTYPE` | yes | the CA letter code |
| `CRC32_SIGN` | yes | CRC32 of the **encrypted** data block |
| `CRC32_FILE` | yes | CRC32 of the **signed** data block |
| `SUBJECT` | yes | document type |
| `SND_NAME`, `SND_EMAIL`, `RCV_NAME` | no | sender and recipient identification |
| `PRG_VER` | no | software version, ≤10 chars |
| `GET_STAMP` | no | ask for a timestamp in the reply |
| `RESULT` | no | 0 success, 1 error, 2 warning |

Two CRC32 checksums over two different blocks, each computed at a
different layer, are the kind of detail that produces silent rejections
when got wrong. `PRG_TYPE` is also notable: the container carries the name
of *our* signing software, so it becomes an identifier we choose once and
keep.

### Message "Документ" — what we send

Structure, in order:

1. sender's signature;
2. the transport header;
3. a data block **encrypted to the recipient**, containing the taxpayer's
   signatures followed by the XML document.

Signature order inside the encrypted block is mandated: chief accountant,
then director, then the company seal, then a branch seal, then the XML.

**For a sole proprietor none of those roles exist** — there is one person
and one key. Which of these slots a ФОП signature occupies, and whether
the order collapses to a single `XXX_SIGN` before the XML, is not stated
in the order. Open question 8, and it is the sort of thing a worked
example would settle instantly.

### Messages we receive

| Format | When |
| --- | --- |
| «Відповідь на документ» | the authority's reply to a submitted document — e.g. a receipt assigning a registration number |
| «Відповідь на документ з позначкою часу» | same, when the header carried `GET_STAMP=1` |
| «Документ з позначкою часу» | the authority's reply to a document request |

All of them arrive as a block **encrypted to the payer**, containing the
authority's signature and the response. So receipts are not readable
without decrypting with the client's key — the квитанції fetched from
`/kvt_by_id` are encrypted to the taxpayer, not plaintext. That has a
direct consequence for us, since a receipt's status is something our
server wants to act on. Open question 9.

### The gap in the published text

Appendix 1 (a worked transport message), appendix 2 (an example document
file), and **appendix 3 (the specifications of the CA crypto-library
functions)** are all marked *«Не наводиться»* — not reproduced. The
structural diagram is a separate attachment, `va499225-10`.

So the order defines the layout but not a single byte-level example. The
missing appendix 3 matters most: it is the interface every CA's library
implements. Whichever crypto library we use will have to supply it.

## The forms, by identifier

The registry of electronic reporting forms gives exact machine
identifiers:

| Form | What it is | Annexes | Deadline |
| --- | --- | --- | --- |
| **F0103309** | ЄП declaration, ФОП **group 3 — quarterly** | F0133109, F0133209 | 40 calendar days after the period |
| **F0103407** | ЄП declaration, ФОП **groups 1–2 — annual** | F0134107, F0134207 | 60 calendar days after the year |

Both under наказ Мінфіну від 19.06.2015 № 578 (зареєстрований 07.07.2015
за № 799/27244), у редакції наказу від 31.01.2025 № 57 (зареєстрований
14.02.2025 за № 232/43638). Registry entry last changed 2026-09-01.

Group 3 periods are cumulative: І квартал, півріччя, три квартали, рік.

> **S:** ДПС, «Реєстр форм звітних документів» — sources.md#dps-forms-registry, read 2026-09-05
> **V:** desk-only (the authority's own registry)
> **C:** high — and independently corroborated twice: Taxer cites the same наказ, and the header of a real filed declaration carries the same reference

**F0103309 is our form.** The owner's profile is group 3, quarterly.

## Where the schemas come from

The same registry page publishes:

| Artefact | What |
| --- | --- |
| `XSD_ALL` | archive of all XML control schemas |
| `Common_types` | shared field-type definitions — **mandatory** for building any reporting XML |
| `PDF_ALL` | archive of the forms as PDF |

Two practical notes that will otherwise surprise someone:

1. The archives are **`.arj`** — a 1990s format. 7-Zip reads it; most
   modern tooling does not.
2. The registry carries a **"дата внесення останніх змін" per form**, and
   separately publishes rows marked **«проєкт для розробників»** — draft
   forms ahead of their effective date.

That second point is a gift for the maintenance problem T4 was worried
about. Form-version churn is not something we discover when a filing
fails; the authority publishes drafts in advance and stamps a change date
per form. Polling the registry is a viable change-detection strategy.

## Anatomy of a real filing

A real submitted F0103309 and its acknowledgements were examined on
2026-09-05. **Only structure is recorded here** — no identifiers, amounts,
or certificate serials.

> **S:** a real filed declaration and its receipts — sources.md#owner-filing-xml, 2026-09-05
> **V:** observed (an actual accepted submission)
> **C:** high for structure

### The document

XML in **windows-1251**, with
`xsi:noNamespaceSchemaLocation="F0103309.XSD"` — the schema file is named
after the form code. Two sections: `DECLARHEAD` and `DECLARBODY`.

`DECLARHEAD` is generic across forms and carries the routing:

| Field | Meaning |
| --- | --- |
| `TIN` | taxpayer number |
| `C_DOC`, `C_DOC_SUB`, `C_DOC_VER` | **the form code, split in three** |
| `C_DOC_TYPE`, `C_DOC_CNT`, `C_DOC_STAN` | type, count, document state (1 = звітний) |
| `C_REG`, `C_RAJ` | region and district codes |
| `PERIOD_MONTH`, `PERIOD_TYPE`, `PERIOD_YEAR` | reporting period |
| `C_STI_ORIG` | the tax office code |
| `LINKED_DOCS` | nil when the document stands alone |
| `D_FILL` | fill date, `DDMMYYYY` |
| `SOFTWARE` | free-text name and version of the producing software |

**The form code decomposes.** `C_DOC` = `F01`, `C_DOC_SUB` = `033`,
`C_DOC_VER` = `9` reassemble into `F0103309`. So the identifier from the
forms registry is not opaque — it is a document class, a sub-code, and a
**version**. That is how a form revision is expressed on the wire, which
matters for the version-churn problem: a new redaction bumps `C_DOC_VER`.

`SOFTWARE` is the document-level analogue of the container's `PRG_TYPE` —
a free-text identifier for whatever produced the file. The observed
filing carried a product name and version string.

### The filename, fully specified

Наказ Міндоходів 29.11.2013 № 729 (registered 06.02.2014 as № 243/25020,
in force since 21.03.2014, never amended) defines the name entirely from
`DECLARHEAD` values — 43 characters plus `.xml`:

| Positions | Source | Padding |
| --- | --- | --- |
| 1–4 | `C_REG` then `C_RAJ` | each left-padded to 2 |
| 5–14 | `TIN` | left-padded to 10 |
| 15–17 | `C_DOC` | — |
| 18–20 | `C_DOC_SUB` | — |
| 21–22 | `C_DOC_VER` | left-padded to 2 |
| 23 | `C_DOC_STAN` | — |
| 24–25 | `C_DOC_TYPE` | left-padded to 2 (`00` for a reporting document) |
| 26–32 | `C_DOC_CNT` | left-padded to 7 (`0000001` when filed once) |
| 33 | `PERIOD_TYPE` | — |
| 34–35 | `PERIOD_MONTH` | left-padded to 2 |
| 36–39 | `PERIOD_YEAR` | — |
| 40–43 | `C_STI_ORIG` | left-padded to 4; equals positions 1–4 for an original |

> **S:** наказ 729 §4 — sources.md#order-729, primary text read 2026-09-05
> **V:** desk-only (primary text), **cross-checked against a real filing**
> **C:** high

**Verified against the observed filing.** Reassembling
`1601 · <TIN> · F01 · 033 · 09 · 1 · 00 · 0000001 · 3 · 06 · 2026 · 1601`
reproduces the real filename exactly, character for character. The earlier
guess in this document that the middle held a fill date was wrong: what
looked like a date is `C_DOC_CNT`'s tail, `PERIOD_TYPE`, and
`PERIOD_MONTH`.

The XSD filename follows the same logic, shorter:
`C_DOC · C_DOC_SUB · C_DOC_VER(2) + .xsd` — hence `F0103309.xsd`, matching
the `schemaLocation` in the real document.

### Codes that matter

`PERIOD_TYPE`: 1 month, 2 quarter, **3 half-year**, 4 nine months, 5 year.

`PERIOD_MONTH` is the **last month of the period** — 3/6/9/12 for quarters,
6 and 12 for half-years, 9 for nine months, 12 for a year. Not the month
you are filing in.

`C_STI_ORIG` = `C_REG × 100 + C_RAJ`, so the office code and the region
pair are redundant with each other by construction.

`C_DOC_STAN`: **1 reporting, 2 new reporting, 3 correcting.**

### The correction flow, answered

`C_DOC_STAN` distinguishes the three document states, and the counters
behave differently:

- `C_DOC_TYPE` is 0 for the first document of a type in a period and
  **increments** with each new-reporting or correcting document;
- `C_DOC_CNT` numbers same-type documents within the period and
  **stays unchanged** on a correction — it keeps pointing at the document
  whose figures are being fixed.

So a correction is a **new file with a new name** (both counters sit in
the filename), not an edit. That closes open question 5, and it tells us
the ledger must be able to reproduce a past period's figures alongside the
corrected ones.

### How annexes and receipts attach

`LINKED_DOCS` is a node of `DOC` elements, each repeating the linked
document's header fields plus its `FILENAME`, with two mandatory
attributes: `NUM` (position in the list) and `TYPE` — **1 = link to an
annex, 2 = link to the main document, 3 = link to the document being
acknowledged.**

That is one mechanism serving three jobs: a main form points at its
annexes, an annex points back, and a receipt points at what it acknowledges.
The observed filing had `LINKED_DOCS` nil because it was filed alone.

### Value rules worth knowing before writing a serialiser

- The XML declaration is exactly
  `<?xml version="1.0" encoding="windows-1251"?>`, lower case.
- All element names are upper case. Root is `DECLAR` with a
  `xsi:noNamespaceSchemaLocation` reference.
- **Element order must match the XSD exactly.**
- Decimal separator is a **dot**; zero is written `0` or `0.00` per the
  schema. The наказ's own example is `<R011G3>0.00</R011G3>` — the same
  element code the real filing carries.
- Dates are `ддммрррр`.
- Character values may not contain `> < " ' &`; use the XML entities.
- Empty elements are `<CODE xsi:nil="true"/>` with the attribute
  **mandatory**. An absent element counts as empty too — so the earlier
  observation that empty rows are emitted is a convention, not a
  requirement.
- No `DECLARHEAD` element except `LINKED_DOCS` and `SOFTWARE` may be empty.
- Documents passed between levels of the receiving body **may carry extra
  service elements and attributes not described by the standard** — so a
  strict parser on the receipt side will break.

One discrepancy to note honestly: the standard says no whitespace or tabs
are allowed between elements, yet the real filing we examined is indented.
Either the rule is not enforced, or the copy exported from a vendor's UI is
prettified relative to what was transmitted. Not worth guessing — worth
knowing before debugging a rejection.

### Four directories ship with the standard

Territorial bodies (`SPR_STI.XML`), reporting documents (`SPR_DOC.XML`),
reporting periods, and **document versions**. All XML, windows-1251, root
`ROWSET` with `ROW` children, upper-case element names.

`SPR_DOC.XML` is the machine-readable source of `C_DOC` / `C_DOC_SUB` /
`C_DOC_VER`, and there is a dedicated versions directory. Together with the
per-form change dates in the forms registry, that is a second, structured
channel for detecting a form revision.

Display templates ship as PDF named like the XSD.

### `DECLARBODY` is the form itself

Header fields (`HTIN`, `HNAME`, `HLOC`, `HEMAIL`, `HTEL`, `HSTI`,
`HNACTL` for employee count), then activity codes as repeated
`T1RXXXXG1S` / `T1RXXXXG2S` elements carrying a `ROWNUM` attribute — КВЕД
code and description in parallel arrays.

Then the numbered rows, named `R<row>G<column>`: `R006G3`, `R011G3`,
`R013G3`, `R0141G3`, `R023G3`, `R025G3` and so on, with unused rows
present but `xsi:nil="true"`. **Empty rows are emitted, not omitted** —
the document is a filled form, not a sparse object.

The observed filing's arithmetic confirms what `legal-frame.md` recorded
from secondary sources: single tax at 5% of period income, military levy
at 1%, both computed cumulatively for the year with the previously
declared amount subtracted to give the sum payable for the quarter.

### The acknowledgement ladder has three rungs, not two

1. **Delivery notice** — a plain-text message: the report reached the ДПС
   mailbox at a timestamp, and *"подбайте про прийом квитанції №1"*.
2. **Квитанція №1** — itself a `DECLAR` XML with its own form code
   (`C_DOC` = `F14`), carrying `HRESULT`
   *"ДОКУМЕНТ ЗБЕРЕЖЕНО НА ЦЕНТРАЛЬНОМУ РІВНІ"* and a pointer to expect
   receipt №2.
3. **Квитанція №2** — the acceptance or rejection after checking.

So receipt №1 means *stored*, not *accepted*. A flow that treats the first
receipt as success would report a filing as done while it is still
unchecked. The `finalKvt` flag in the REST API is what distinguishes
them — and this observation is why it matters.

The receipts are UTF-8, while the declaration is windows-1251. Encoding is
per-document, not per-channel.

### Both receipts, side by side

A second real receipt — квитанція №2, downloaded from the cabinet — pins
the ladder down completely.

| | Receipt №1 | Receipt №2 |
| --- | --- | --- |
| Form | `F14` / `991` / ver 2 | `J14` / `992` / ver 2 (`J1499202.XSD`) |
| `C_DOC_TYPE` | 0 | 1 |
| `HRESULT` | «ДОКУМЕНТ ЗБЕРЕЖЕНО НА ЦЕНТРАЛЬНОМУ РІВНІ…» | **«Прийнято пакет.»** |
| `HNUMREG` | nil | **a registration number** |
| `SOFTWARE` | the Єдине вікно system | a different ДПС system identifier |
| `HTIME` | `10:27:16` | `10:28:37.669+03:00` |

Three things follow.

**The registration number arrives with receipt №2.** Receipt №1 leaves
`HNUMREG` empty. So the marker of a genuinely filed return is not the
first acknowledgement — it is the number on the second. That is the value
our ledger should store as proof of filing.

**The gap was about 81 seconds** in this sample. One observation, not a
guarantee, but it sets the order of magnitude for the poll loop: seconds
to minutes, not hours. Worth confirming across more filings before choosing
an interval.

**The receipt links by filename, not by `LINKED_DOCS`.** Both receipts
carry the acknowledged document's `HFILENAME` and `HDOCKOD` in the body and
leave `LINKED_DOCS` unused. So although наказ 729 provides `TYPE=3` for
exactly this relationship, the receipts we observed identify their subject
through body fields instead. Match on `HFILENAME`, and do not rely on
`LINKED_DOCS` being populated.

Also worth knowing: `HDOCNAME` on the receipt reads *«…(для третьої групи -
квартал, мiсяць)»* — F0103309 covers **monthly as well as quarterly**
periods for group 3. And their strings mix Cyrillic and Latin `i`
(«декларацiя», «фiзичної», «пiдприємця»), so never string-match on ДПС
document names.

### Open question 8 is answered

Квитанція №1 lists the signatures it saw:

> Підписи документа: **- перший - директор**, …

A sole proprietor's single signature is recorded in the **director** slot,
not the accountant slot. The mandated order in наказ 499 collapses for a
ФОП to one signature in position two of the list, and the authority
itself labels it "директор".

Confirmed by the authority's own receipt, which is as good as this gets
without a byte-level example.

## The acknowledgement model, concretely

This is the асинхронна частина, and the documentation is specific enough
to design against.

`ReturnReport`, returned by `/report`:

```
id            int64   — the submission identifier
kvt1Base64    string  — the first receipt, returned with the submission
kvt1Fname     string
kvtList       ReturnKvt[]
message       string
status        OK | ERROR | ERROR_DECRYPT | ERROR_STRUCT_REPORT |
              ERROR_LINKED_DOCS | ERROR_DB | ERROR_SERTIF_ORG |
              ERROR_SERTIF | ERROR_XSD | NOT_KVT
```

`ReturnKvt`:

```
numKvt      int    — receipt number: 1, 2, ...
finalKvt    0 | 1  — whether this is the last receipt
kvtBase64   string
kvtFname    string
status      -1 error | 0 undetermined | 1 accepted
```

So the flow is: submit → receive `id` and receipt №1 immediately → poll
`/kvt_by_id` until a receipt arrives with `finalKvt = 1` → the terminal
outcome is that receipt's `status`.

**This maps onto our outbox almost exactly.** Submission is one durable
step; acknowledgement is a poll loop with a defined terminal condition,
not an unbounded wait on an opaque state. `finalKvt` is the thing that
makes it tractable — without it we would be guessing when to stop.

The status enum also gives the retryable/terminal split we needed:
`ERROR_XSD`, `ERROR_STRUCT_REPORT`, `ERROR_DECRYPT`, `ERROR_SERTIF` and
`ERROR_SERTIF_ORG` are **our** faults and will fail identically on retry;
`ERROR_DB` is theirs and is worth retrying. `NOT_KVT` means no receipt yet.

## Authentication — half answered, and the half that is missing matters

The **private-part read API** — a different base, `https://cabinet.tax.gov.ua/ws/public_api/` — authenticates like this:

> `Authorization`: the taxpayer's ЄДРПОУ/РНОКПП, signed with an internal
> signature, with the certificate attached, in base64.

**Authentication is a signing operation with the client's own key.** There
is no API key, no OAuth, no service account.

> **S:** ДПС, «Опис API доступу до інформації приватної частини ЕК» — sources.md#dps-cabinet-private-api, read 2026-09-05
> **V:** desk-only
> **C:** high for the read API

The submission API documentation does **not** state an `Authorization`
header, yet defines 401 and 403 responses. Two possibilities:

- the signed and encrypted transport container is itself the credential,
  in which case `target-flow.md` works exactly as written — the owner
  signs once, and we submit on our own schedule;
- or the same signed-identifier header applies, in which case something
  has to produce a signature at submission time, and the owner may need to
  be present for that too.

That is open question 1, and it is the most consequential thing left in
this topic. It is also cheaply answerable: the owner has a real key and
can watch what the cabinet's own web client sends.

## The private-part read API is much larger than first recorded

A first pass through this documentation was truncated and under-reported
it. Read in full on 2026-09-05, it turns out to cover most of what a
filing product needs to *see*, not just to send.

Base: `https://cabinet.tax.gov.ua/ws/public_api/`. Every call takes the
same `Authorization` header — the taxpayer's identifier signed with their
own key, certificate attached, base64.

### Filed documents can be listed and downloaded

| Purpose | Path |
| --- | --- |
| List filings for a period | `GET /reg_doc/list?periodYear=&periodMonth=` |
| One filing with its annexes | `GET /reg_doc/docs/{year}/{id}` |
| Download as PDF | `GET /reg_doc/doc/{year}/{id}/pdf` |
| Download as XML | `GET /reg_doc/doc/{year}/{id}/xml` |

The list rows carry `doc` (form code), `cdocSub`, `cdocVer`, `cdocCnt`,
`cdocType`, the period triple, `dterm` (deadline), `dget` (received),
`nreg` (**registration number**), `flags` with a human `flagName` such as
«Прийнято в режимі On-line», `docName`, and `cntAppendix`.

`reg_doc/docs` returns the parent document **and its receipts** in one
array, linked by `codRegdocRef` pointing at the parent's `codRegdoc`. The
documentation's own example shows a row with `docName` = «Квитанцiя № 2»,
`doc` = `J1499202`, `cdocSub` = `992` — the same form code as the real
receipt we examined.

### Incoming correspondence, including receipts

| Purpose | Path |
| --- | --- |
| List incoming | `GET /post/incoming?page=` |
| Download as PDF | `GET /incoming/{year}/{id}/pdf` |
| Download as XML | `GET /incoming/{year}/{id}/xml` |

Rows carry `cdoc`, `name` (e.g. `Квитанцiя № 2[J1499202]`), `dateIn`,
`isRead`, `status`, and `codRegdocRef` linking back to the document being
acknowledged.

### This substantially answers open question 9

The worry was that receipts arrive **encrypted to the payer**, so our
server could not read an acknowledgement without the client's key
participating again.

That is true of the container path. But it is not the only path: the
private-part API serves the same receipts as **plain PDF or XML**,
already decrypted by the authority, addressed by document id.

So acknowledgement tracking has an alternative design — poll
`reg_doc/list` or `post/incoming` and read `nreg` and `flagName`, instead
of decrypting `kvt_by_id` payloads. Both still need the signed
`Authorization` header, so open question 1 is untouched; but the
**decryption** problem for receipts is avoidable.

### The `Authorization` value is reusable by construction

What gets signed is **the taxpayer's own identifier** — «ЄДРПОУ/РНОКПП
підписаний внутрішнім підписом з додаванням сертифікату в BASE64». The
documentation names no timestamp, no nonce, and no request binding in the
signed payload.

So for a given key and certificate the header is **the same bytes every
time**. It is replayable by construction, and the only thing that can
limit it is a server-side expiry we cannot see.

> **S:** the documented header definition — sources.md#dps-cabinet-private-api; corroborated by owner observation that a signing key is used once per session in a third-party product, after which documents can be browsed and a declaration submitted — 2026-09-05
> **V:** desk-only for the construction; owner for the behaviour
> **C:** high that the value is reusable; **unknown** for how long

One caveat on the corroboration: what the owner observed is that the
*person* touches the key once. A browser product could equally hold the
key in memory and re-sign transparently, which would look identical. That
alternative matters because our server signs nowhere — the owner signs on
their device and the server acts later. It is unlikely given the signed
payload is a constant, but it is not excluded by the observation alone.

**The question therefore narrows from "is it reusable" to "for how
long".** Two things bound it regardless of any server policy: the
certificate's own validity, and its revocation.

### Consequence: that header is a credential, not a cache entry

If the value is a replayable constant, then holding it is equivalent to
holding a **long-lived bearer credential for that taxpayer's tax
cabinet** — it reads their registration card, their bank accounts, their
settlement state and their filed documents.

So it must be handled as a secret of that weight: encrypted at rest,
never logged, scoped to the tenant, revocable by re-issuing the
certificate, and with a deliberate retention window rather than "until it
stops working". This is a design constraint for
[SHO-450](https://linear.app/showzy-v2/issue/SHO-450), and it is more
consequential than it looks — the convenience that makes unattended
filing possible is exactly what makes the stored value dangerous.

### The channel choice decides whether we need the client's encryption key

This is the sharpest architectural consequence found so far, and it came
from looking at how a third-party product actually serves a receipt.

Observed 2026-09-05: a vendor endpoint returns a квитанція as **plaintext
base64 XML** plus a separate **XSLT** for rendering it. So by the time it
reaches their own UI it is already decrypted. Per the owner, viewing it in
that product **requires the encryption key** — the second key in the
container, labelled «шифрування».

> **S:** owner-supplied vendor API response and the owner's account of the flow — sources.md#taxer-receipt-endpoint, 2026-09-05
> **V:** observed
> **C:** high for the response shape; owner for the key requirement

That fits: the vendor files through **Єдине вікно**, where receipts arrive
as containers **encrypted to the payer**. CMS `KeyAgreeRecipientInfo`
decryption needs the recipient's *private* key to perform the key
agreement, so it can only happen where that key is. Hence the prompt.

The cabinet REST API has no such step. It serves the same receipts already
decrypted, as XML or PDF.

| | Єдине вікно | Cabinet REST API |
| --- | --- | --- |
| Receipt arrives as | container encrypted to the payer | plain XML or PDF |
| Needs the client's **encryption** key | yes, to decrypt | no |
| Rendering | your own template per form | `/pdf` endpoint provided |

**So the channel choice is not a detail.** Going through Єдине вікно
imports a requirement our architecture explicitly avoids — the client's
private key participating on our side, repeatedly, long after signing.
Going through the cabinet API removes it: the owner signs the declaration,
and everything afterwards is reads authorised by a signed header.

This is now a strong argument for the cabinet API beyond convenience, and
it belongs in the [SHO-449](https://linear.app/showzy-v2/issue/SHO-449)
fork alongside the others.

**One more thing that channel gives free.** Наказ 729 says display
templates ship as PDF per form; the vendor evidently maintains XSLT
templates instead, one per form code — the observed stylesheet is class
`X1499102`, matching the receipt's form code with `X` standing in for the
series letter. Rendering receipts ourselves would mean owning that
template set. The cabinet's `/pdf` endpoint means not owning it at all.

### Taxpayer registration data in one call

`GET /payer_card` returns the payer's card in 16 blocks: identification,
registration, directors, non-profit status, **VAT registration**,
**єдиний податок registration**, **ЄСВ registration**, goods-operations
registry, РРО, books, **ПРРО**, objects of taxation, secondary
registration places, **bank accounts**, contracts, and activity types
(КВЕД). A single block can be fetched with
`GET /payer_card/{group}?page=&size=`.

Two of those are directly useful to us:

- **The єдиний податок block** tells us the client's group and rate from
  the authority, instead of asking them to self-declare it during
  onboarding — and self-declaration is exactly where a wrong tax
  calculation would start.
- **The bank accounts block** (`/payer_card/14`) returns `MFO`,
  `MFO_NAME`, the account IBAN, currency and registration dates. That
  cross-checks against [SHO-451](https://linear.app/showzy-v2/issue/SHO-451):
  we can confirm the account a client connects is genuinely their
  registered ФОП account, rather than trusting the connection alone.

## Bonus: the account-state API is worth more than it looks

`GET /ws/public_api/ta/splatp?year=YYYY` returns the taxpayer's settlement
state with the budget, per payment type. Fields include `namePlt`
(payment name — e.g. військовий збір), `narah0` (assessed), `splbd0`
(paid), `nedoim0` (arrears), `perepl0` (overpaid), and — notably —
`budgetAccountIban`, `budgetPayerName`, `budgetMfo`, `budgetBankName`.

Two uses:

1. **It carries the actual budget IBAN and recipient for that specific
   taxpayer.** [SHO-448](https://linear.app/showzy-v2/issue/SHO-448) is
   about to go looking for a payment-requisites directory keyed by
   locality; this may supply the same information per payer, from the
   authority, already resolved. Worth checking before building the
   directory the hard way.
2. **It closes the loop on payment.** The flow tells the owner what to
   pay; this says whether it landed and whether anything is owed. Taxer
   surfaces the same thing.

Same signature-based authentication applies, so it inherits open
question 1.

## What this does to the T6 fork

[SHO-449](https://linear.app/showzy-v2/issue/SHO-449) left open whether
filing should go through a provider, as fiscalisation will. The main
argument for a provider would have been "there is no channel for a third
party". There is one, it is official, and it is documented.

The remaining arguments for a provider are form-version maintenance and
container/signature handling — and the registry's per-form change dates
and developer-draft rows make the first tractable, while the second is
work we already do in `packages/document-signing`.

The evidence now points at filing directly. Recording it as evidence, not
as a decision — the call is the owner's.

## Open questions

1. **What authenticates a submission?** Is the signed container the
   credential, or is a signed `Authorization` header also required? Still
   unstated for `/cabinet/public/api/exchange`. But the *reuse* half of
   this question is now largely settled — see below.
2. ~~Which certificate do we encrypt to?~~ **Answered.** The Електронний
   кабінет API certificates are published at
   `cabinet.tax.gov.ua/cabinet/resources/js/sign/data/EK_S_NEW.cer`
   (signing) and `EK_C_NEW.cer` (encryption). They **rotate** — the current
   pair took effect 2025-08-06 — so they are refreshable configuration,
   not constants. Details in `kep-signing.md`.
3. **What are annexes F0133109 and F0133209?** One is presumably the ЄСВ
   annex referenced in `legal-frame.md` §1. Confirm which, and whether both
   are mandatory for our profile.
4. **Is there a sandbox for reporting?** The ПРРО section names
   `cabinet.tax.gov.ua:9443` as a developer test endpoint and states plainly
   that documents sent there are not fiscal. Nothing equivalent is stated
   for reporting, and filing a real declaration as a test is not an option.
5. ~~Correction flow?~~ **Answered by наказ 729.** `C_DOC_STAN` 1/2/3 marks
   reporting, new-reporting and correcting; `C_DOC_TYPE` increments while
   `C_DOC_CNT` stays fixed on the document being fixed. A correction is a
   **new file with a new name**, not an edit — so the ledger must be able
   to reproduce a past period's figures alongside the corrected ones.
6. **Rate limits** — undocumented.
7. ~~What is our `CERTYPE` letter?~~ **Answered: `UA1`.** A single constant
   for the post-2012 certificate formats, not a per-CA letter. ДПС notice
   of 2013-01-11. See above.
8. ~~How does a sole proprietor's single signature map onto the mandated
   order?~~ **Answered.** Квитанція №1 on a real filing lists it as
   «перший - директор» — the ФОП signature occupies the **director** slot.
   See "Anatomy of a real filing".
9. ~~Receipts arrive encrypted to the payer.~~ **Largely answered.** The
   private-part API serves receipts as plain PDF or XML via
   `/reg_doc/docs`, `/reg_doc/doc/{year}/{id}/xml` and
   `/post/incoming` — already decrypted by the authority. Acknowledgement
   tracking does not require decrypting containers. It still requires the
   signed `Authorization` header, so this now folds entirely into question
   1: **can that signature be produced once and reused, or must it be
   minted per call?** That single answer decides how unattended the flow
   can be.

### No container was obtainable, and we do not know where it is built

The owner looked for a way to export a transport container from the
Електронний кабінет and found none: the cabinet offers **documents** — the
declaration XML and both receipts — with no container anywhere in the
interface.

> **S:** owner, 2026-09-05
> **V:** owner
> **C:** high for "not exportable from the cabinet UI"

An attempt to find the assembly code in the cabinet's client was
**inconclusive and should not be read as evidence.** Two bundles served to
an *unauthenticated* visitor (`scripts-*.js`, `main-*.js`) contain none of
`TRANSPORTABLE`, `CERTYPE`, `_CRYPT`, `GOST28147`, `EUSign` or `euscp`, and
several guessed paths under `cabinet/resources/js/sign/` return 404 —
including the certificate path the 2025 press release named, which is how
we learned those URLs are stale.

But the signing UI lives in the authenticated part of an Angular
application with lazily loaded chunks, none of which were enumerated. Two
anonymous bundles say nothing about where the container is built. Client
side in a lazy chunk, an external signing agent, and server side all remain
open.

So questions 7 (`CERTYPE`) and 9 (encrypted receipts) still need a route:

- **ask ДПС developer support** — the API page carries a support line and a
  feedback address, and by now our questions are specific enough to be
  answerable in a sentence each;
- enumerate the authenticated cabinet's chunks while signing something,
  which requires a real session and a real submission;
- or defer, and let a first implementation attempt produce a rejection that
  names the problem.

The first is cheapest and worth doing before any code is written.

### Both container unknowns are answered — and the 2012 format change explains them together

**`CERTYPE` = `UA1`.** Not a per-CA letter. ДПС published a notice on
2013-01-11, implementing the joint Мін'юст / Держспецзв'язку order of
2012-08-20 on new formats, structures and protocols: to have reporting
accepted with certificates in the **new formats**, the transport header's
`CERTYPE` field must carry the designation **`UA1`**.

> **S:** ДПС notice via Урядовий кур'єр — sources.md#dps-certype-ua1, published 2013-01-11, read 2026-09-05
> **V:** desk-only (official notice)
> **C:** **medium** — see the caveat below; downgraded from high on 2026-09-05

#### Caveat: the notice's legal basis has been repealed

The 2013 notice defines "new formats" by reference to the joint
Мін'юст / Держспецзв'язку order of 2012-08-20 № 1236/5/453. That order is
dead, and so is everything that replaced it:

| Instrument | Fate |
| --- | --- |
| `z1398-12` — наказ 1236/5/453 (2012) | repealed **2020-01-01** by z1172-19 |
| `z1172-19` (2019) | repealed **2020-11-10** by z1039-20 |
| `z1039-20` (2020) | repealed **2026-03-26** by z0375-24 |
| `z0375-24` (2024) | **current — and it only repeals; it establishes nothing** |

The framework moved up a level, to **ПКМУ від 28.06.2024 № 764 «Деякі
питання електронної ідентифікації та електронних довірчих послуг»**
(current edition 2026-07-16). The ministerial orders were repealed as
redundant, not because the requirements vanished.

> **S:** the repeal chain on `zakon.rada.gov.ua`, read 2026-09-05
> **V:** desk-only (document cards read directly)
> **C:** high — each card states its own repeal and successor

**What this does and does not mean.** It does **not** invalidate наказ 499:
that is ДПС's own instrument, never amended, and `CERTYPE` is its field.
What it removes is the legal anchor the 2013 notice used to say *which*
certificates count as "new format".

So `UA1` remains the best available answer, but its support is now a 2013
notice resting on a repealed order, plus one third-party implementation of
unknown vintage. That is medium confidence, not high, and it should be
verified against something current before the first filing — or simply
proven by that filing, since a wrong `CERTYPE` produces an explicit
rejection rather than silent corruption.

**`UA1_CRYPT` carries a CMS envelope, not raw ciphertext.** A working
third-party implementation builds the block as
`"UA1_CRYPT"` · `0x00` · 4-byte **little-endian** length · the output of
the signing library's `EnvelopData()` — an envelope/CMS structure taking
a recipient issuer and serial, not a bare cipher.

The same code builds `UA1_SIGN` from `SignDataInternal(true, …)` — an
**internal, i.e. attached** signature, confirming that the signed data
travels inside the block.

> **S:** `GorulkoAV/EUSignDFS`, `DFSPackHelper.cs` — sources.md#eusigndfs
> **V:** observed (a third-party implementation, not an official spec)
> **C:** medium-high

### Why the earlier reading from наказ 485 was wrong

This document previously concluded the opposite — raw ГОСТ 28147-89
ciphertext — reasoning that наказ 485 puts the session key and IV in the
header requisites, where CMS would carry them internally. That inference
was sound about наказ 485 and wrong about today.

The resolution is the **2012 format change**. Наказ 485 is from 2008 and
describes the pre-2012 container: per-CA letters, key material carried in
the header. The 2012 joint order replaced those formats, and the same
change is what turned `CERTYPE` from a per-CA letter into the single
constant `UA1`. Both facts come from one event.

So the 2008 and 2010 texts describe a container that the 2012 order
superseded in exactly the two places we were unsure about. Read them for
the framing, not for the crypto.

**Consequence:** UAPKI's `ENCRYPT`, which emits CMS `EnvelopedData`, is
the right entry point after all — see `kep-signing.md`.

### Where the implementation diverges from наказ 499

Worth knowing before treating either as authoritative, because it diverges
in both directions:

- **Extra tags** not in наказ 499's table: `EDRPOU`, `STTYPE=1`, and a
  `CERTCRYPT` tag carrying certificate bytes before the crypt block.
- **Missing tags** that наказ 499 marks mandatory: `CRC32_SIGN`,
  `CRC32_FILE` — and, in the part examined, `CERTYPE` itself.

That one repository may also target a different document flow than ours.
So: the наказ for the frame, the implementation for what a real system
actually emits, and neither alone as truth. The divergences are worth
resolving against a real accepted container before shipping.

### The older reading, kept for context

Наказ 499 publishes no appendices, but its **predecessor** does. Наказ ДПА
№ 485 від 22.07.2008 covers the same unified format and prints the
container-structure appendix that 499 omits.

Its decisive detail: **«Реквізити шифрування даних» sit in the transport
header**, and they hold —

- certificate fingerprints and owner names for sender and recipient,
- the **encrypted session key**,
- the **initialisation vector**,
- the encrypted data length.

> **S:** наказ ДПА 22.07.2008 № 485, appendix 2 — sources.md#order-485, read 2026-09-05
> **V:** desk-only (predecessor standard, read as a summary rather than verbatim)
> **C:** medium-high — the structural argument is strong; the text is one revision behind наказ 499

**A CMS `EnvelopedData` carries all of that internally** — recipient info,
the wrapped session key, and the content-encryption parameters are part of
the ASN.1 structure. Here they are external, in the header.

So `XXX_CRYPT` almost certainly holds a **raw ГОСТ 28147-89 ciphertext**,
not a CMS envelope.

**This corrects an earlier note in `kep-signing.md`.** The reasoning there —
that the ecosystem converged on CMS, so `ENCRYPT` would emit the right
bytes — pointed the wrong way. UAPKI's `ENCRYPT` produces `EnvelopedData`;
this container appears to want the cipher output plus separately-carried
key-agreement material. That is a different call shape, and possibly
lower-level primitives than the high-level `ENCRYPT` method.

Not certain, and two things could still change it: наказ 499 restructured
section 5 in 2010, and ДПС's current implementation may well accept a CMS
envelope regardless of what the order describes. But planning should assume
raw ciphertext until a real container says otherwise.

### Two more details the predecessor supplies

**The container file is named `.cri`** — same name as the document it
carries, different extension.

**The section layout is richer than наказ 499 states.** Appendix 2 gives
each section as: a null-terminated variable-length signature, a 4-byte
header size excluding that signature, a 4-byte encrypted block size, a
4-byte signature offset, a 4-byte signed data block size, then the data.
Наказ 499's text describes only signature · `0x00` · one 4-byte length ·
payload. Either the 2010 revision simplified it, or 499 describes it
loosely. Worth resolving before writing a serialiser.

### The missing appendices

Наказ 499 does not publish appendix 1 (a worked transport message),
appendix 2 (an example document), or appendix 3 (the CA crypto-library
function specifications). The structure is fully specified; not one
byte-level example is. Questions 7 and 8 both exist only because of that
gap, and both would be answered instantly by a single real container —
which the owner can produce from the cabinet with their own key.

## Out of scope, but recorded

The same page documents the **ПРРО fiscal server API** in full: gRPC with
proto3 at `prro.tax.gov.ua:443` (fallback `prro2`), a developer test
endpoint at `cabinet.tax.gov.ua:9443`, method `sendChkV2`, the `Check` and
`CheckResponse` messages, the complete error enum including
`ERROR_OFFLINE_168` and `ERROR_BAD_HASH_PREV`, shift semantics, and
chaining by hash of the previous check's XML.

Fiscalisation goes through a provider by owner decision (`vendors.md`), so
none of that is ours to implement. Noted only so that a future revisit
knows the protocol is publicly and completely documented, with a test
environment — which was open question 6 on the cancelled
[SHO-446](https://linear.app/showzy-v2/issue/SHO-446).
