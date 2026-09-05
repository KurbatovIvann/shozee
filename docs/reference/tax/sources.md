# Source register

Every load-bearing claim in this tree points here. A topic file cites a
key; this file says exactly what was read and when.

## Rules

- **Register the source when you use it**, not later. An unregistered
  source makes its claim unverifiable.
- **Date every fetch.** Tax formats and thresholds move by наказ; a URL
  without a date says nothing about what it said when we read it.
- **Prefer the primary act** over an accountant's blog summarising it.
  A secondary source is acceptable evidence when it is named as such and
  the confidence is discounted accordingly.
- **Archive what can move.** If a source is a PDF, an XSD, or a
  specification version that can be silently replaced, note its version
  and, where licensing allows, keep a copy under `archive/` next to this
  file with the fetch date in the filename.
- **Never register a source that requires our key to view and contains
  real personal or business data.** Describe what was seen instead.

### Retrieval note

Every `*.tax.gov.ua` host (including regional `xx.tax.gov.ua`) returns
HTTP 403 to server-side fetching, but renders normally in a browser.
Official ДПС pages are reachable — use the browser route rather than
concluding the page is gone. `zakon.rada.gov.ua` serves document
metadata and version dates readily, but returned only a lossy translated
summary of article text; a better route to primary text is still needed
(open question 2 in `legal-frame.md`).

## Format

| Key | Kind | Title | URL / location | Version | Fetched | Used by |
| --- | --- | --- | --- | --- | --- | --- |

`Kind` is one of: `act` (law, code, наказ), `spec` (protocol or schema
documentation), `official-page` (authority website content), `secondary`
(vendor docs, integrator write-ups, accountant press), `observed`
(something seen first-hand in the cabinet or against an environment).

## Register

| Key | Kind | Title | URL / location | Version | Fetched | Used by |
| --- | --- | --- | --- | --- | --- | --- |
| `dps-2026-rates` | official-page | 2026 рік для ФОП: нові розміри єдиного податку та військового збору | `tax.gov.ua/media-tsentr/novini/968282.html` | published 2026-01-01 | 2026-09-05 (browser) | T1 §1 |
| `dps-dn-2026-limits` | official-page | ФОП 2026: ліміти доходу — ГУ ДПС у Донецькій області | `dn.tax.gov.ua/media-ark/news-ark/984053.html` | published 2026-02-25 | 2026-09-05 (browser) | T1 §1, §3 |
| `rro-law` | act | ЗУ «Про застосування реєстраторів розрахункових операцій…» № 265/95-ВР | `zakon.rada.gov.ua/laws/show/265/95-вр` | редакція 2026-06-26; next revision 2026-11-01 | 2026-09-05 | T1 §2 |
| `dtkt-rro-2026` | secondary | РРО та ПРРО для ФОПів у 2026 році: повний перелік винятків та правила застосування | `news.dtkt.ua/state/cash-handling/108895-…` | published 2026-03-10 | 2026-09-05 | T1 §2 |
| `rro-exemptions-2026` | secondary | Aggregated: dtkt 107176, yankiv.com, 7eminar 2521, smartkasa — cross-checked for the group 1-only exemption | search results, individual URLs in the topic file's history | read as search summaries | 2026-09-05 | T1 §2 |
| `mof-vat-draft` | secondary | ПДВ стає обов'язковим для єдинників: проєкт Закону від Мінфіну | `7eminar.ua/news/15502-…` | published 2025-12-18 | 2026-09-05 | T1 §3 |
| `reporting-cadence` | secondary | Aggregated declaration/ЄСВ/ВЗ cadence for groups 2–3 (dtkt, buhplatforma, bip.net.ua, 7eminar) | search results | read as search summaries | 2026-09-05 | T1 §1, §4 |
| `order-729` | act | Наказ Міндоходів 29.11.2013 № 729 — Формат (стандарт) електронного документа звітності: filename and XSD naming, DECLARHEAD semantics, value rules, directories | `zakon.rada.gov.ua/laws/show/z0243-14` | registered 06.02.2014 № 243/25020; in force 21.03.2014; never amended | 2026-09-05 (browser, full primary text) | T4 |
| `owner-filing-xml` | observed | A real accepted F0103309 filing with its delivery notice and квитанція №1 — document anatomy, field names, acknowledgement ladder, signature slot. **Structure only; no identifiers, amounts or certificate serials recorded** | owner's own filing, shared 2026-09-05 | filed 2026-07 | 2026-09-05 | T4, T2 |
| `taxer-receipt-endpoint` | observed | A vendor's receipt endpoint response: квитанція as plaintext base64 XML plus an XSLT render template (`X1499102`); owner reports the flow requires the encryption key | owner-supplied response, 2026-09-05 | — | 2026-09-05 | T4, T2 |
| `owner-kep-keys` | observed | КЕП file-key manager showing two keys in one container: «підпис» and «шифрування», issued by a КНЕДП | owner's screenshot, 2026-09-05 | — | 2026-09-05 | T2 |
| `uapki-vendored` | observed | Vendored UAPKI source in `packages/document-signing/cpp/` — dispatch table, `encrypt.cpp`, algorithm OIDs, CMakeLists | our own repository | upstream `specinfo-ua/UAPKI` tag v2.0.16 | 2026-09-05 | T2 |
| `format-repeal-chain` | act | Repeal chain for signature-format requirements: z1398-12 (2012) → z1172-19 → z1039-20 → **z0375-24 (current, repeal-only)**; framework moved to ПКМУ 28.06.2024 № 764 | `zakon.rada.gov.ua` document cards | z0375-24 in force 2026-03-26; ПКМУ 764 ed. 2026-07-16 | 2026-09-05 (browser) | T2, T4 |
| `dps-certype-ua1` | official-page | ДПС notice «До уваги АЦСК та розробників програмного забезпечення» — `CERTYPE` must be **`UA1`** for the new certificate formats (joint Мін'юст/Держспецзв'язку order of 2012-08-20) | `ukurier.gov.ua/uk/news/do-uvagi-acsk-ta-rozrobnikiv-programnogo-zabezpech/` | published 2013-01-11 | 2026-09-05 | T4 |
| `eusigndfs` | secondary | `GorulkoAV/EUSignDFS`, `DFSPackHelper.cs` — a working container packer: `UA1_SIGN` from `SignDataInternal(true,…)`, `UA1_CRYPT` from `EnvelopData()`, little-endian lengths, `TRANSPORTABLE` header assembly | `github.com/GorulkoAV/EUSignDFS` | third-party, may target a different document flow | 2026-09-05 | T4, T2 |
| `order-485` | act | Наказ ДПА 22.07.2008 № 485 — predecessor of наказ 499; **prints the container-structure appendix that 499 omits**, incl. encryption requisites, section layout and the `.cri` extension | `docs.dtkt.ua/doc/v0485225-08` | 2008 text, superseded by 499 | 2026-09-05 | T4, T2 |
| `order-499` | act | Наказ ДПА України 12.07.2010 № 499 — Уніфікований формат транспортного повідомлення (container layout, crypto standards, message formats) | `zakon.rada.gov.ua/rada/show/v0499225-10` | original 2010 text; never amended | 2026-09-05 (browser, full primary text) | T4, T2 |
| `dps-edina-adresa` | official-page | ДПС «Єдина адреса» — the durable distribution page for signing and encryption certificates, all generations 2014→2025 with direct links | `tax.gov.ua/elektronna-zvitnist/platnikam-podatkiv-pro/edina-adresa/` | current generation 2025-08-06 | 2026-09-05 (browser) | T2 |
| `dps-certificates` | official-page | ДПС, «Змінюються кваліфіковані сертифікати...» — locations of the signing and encryption certificates, and evidence that they rotate | `tax.gov.ua/media-tsentr/novini/920738.html` | announcement of the 2025-08-06 rotation | 2026-09-05 (browser) | T2 |
| `dps-cabinet-api` | spec | ДПС, «Опис API Електронного кабінету» — report submission, receipts, and the ПРРО gRPC API | `cabinet.tax.gov.ua/help/api.html` | undated page | 2026-09-05 (browser) | T4 |
| `dps-cabinet-registers-api` | spec | ДПС, «Опис API доступу до реєстрів відкритої частини ЕК» — CSV exports, REST search, self-minted token with a 1000/day cap | `cabinet.tax.gov.ua/help/api-registers.html` | undated page | 2026-09-05 (browser, full text) | T5 |
| `dps-cabinet-private-api` | spec | ДПС, «Опис API доступу до інформації приватної частини ЕК» — signature-based auth, settlement state | `cabinet.tax.gov.ua/help/api-registers-int.html` | undated page | 2026-09-05 (browser) | T4 |
| `dps-forms-registry` | official-page | Реєстр форм звітних документів — form ids, annexes, deadlines, XSD_ALL, Common_types, per-form change dates, developer drafts | `tax.gov.ua/data/material/000/006/58768/Forms_deklar.htm` | registry entries stamped 2026-09-01 | 2026-09-05 (browser) | T4 |
| `owner-declaration-pdf` | observed | A real filed ЄП declaration (form header only — the наказ reference). Personal content deliberately not recorded | owner's own document, shared 2026-09-05 | form per наказ 578 у ред. 57 | 2026-09-05 | T4 |
| `mono-personal` | spec | Monobank open API (personal) — carries the policy that a hosted service must use the providers API | `api.monobank.ua/docs/index.html` | v250818 | 2026-09-05 (browser) | T8 |
| `mono-corporate` | spec | Monobank open API for providers — company onboarding, client consent, statement, webhook, monoКЕП | `api.monobank.ua/docs/corporate.html` | v260831 | 2026-09-05 (browser) | T8 |
| `privat-autoclient` | spec | PrivatBank Автоклієнт API specification, linked from `privatbank.ua/business/intehratsiya` | published Google Doc | unversioned — drift is hard to detect | 2026-09-05 | T8 |
| `taxer-observed` | observed | Taxer product surfaces: tax calendar, declaration task, three payment forms | owner's own account, screenshots shared 2026-09-05 | product state on that date | 2026-09-05 | target-flow.md |
| `stock-records-496` | secondary | Наказ Мінфіну від 03.09.2021 № 496, Порядок ведення обліку товарних запасів — as reported by dtkt, buhgalter911, yankiv | order itself not read | 2026 status reported current | 2026-09-05 | T1 §5 |

### Registered but not yet read in primary text

`rro-law` Article 9 and ПКУ 296.10 back the heaviest claim in T1 §2 and
are still known only through summaries. Raising them to a primary read is
the first task of the next pass.
