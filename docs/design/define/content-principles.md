# Showzy V2 — Content Principles

> Status: Approval #2 granted by the owner on 2026-08-17  
> Linear: SHO-12 · Stage: DEFINE  
> Evidence: approved constraints and internal assumptions only

## Purpose and authority

These Ukrainian-first principles cover classic UI, AI, notifications, states,
and entry paths for Staff, Global discovery, and Customer company contexts.
English action names, enums, permission keys, IDs, and module terms remain
internal.

Content must agree with approved scope/ADRs and the Linear feature card
plus executable contracts (ADR-0023). Research and the working terms here
provide evidence, not a separate domain specification. Visual authority
is the Magic Patterns canvas (ADR-0024); the historical DEFINE approval
below does not reopen archived component or journey contracts.

There is no external language research. Pricing, catalog, invite, delivery,
document, and signing labels remain assumptions where approved specs or legal
review do not yet exist.

## Core voice

### Ukrainian first

- Localize navigation, actions, states, help, notifications, AI, and accessible
  labels.
- Preserve registered names, brands, SKUs, document numbers, Showzy, Нова
  пошта, PDF, ASiC-E, SKU, and КЕП where applicable.
- Never expose `companyId`, action/error names, enums, or permission keys.
- Use one Ukrainian term for each domain object across every channel.

### Object → state → next action

Lead with what changed and what the user can do:

> Замовлення підтверджено. Відкрийте чат, щоб узгодити доставку.

Avoid:

> Операцію успішно завершено.

Separate:

- Domain state: `Замовлення підтверджено`.
- Operation: `Оновлюємо замовлення…`.
- Synchronization: `Зміни ще не синхронізовано`.
- Delivery projection: `Сповіщення не надіслано`.

### Facts, not confidence

- Proposal: `Можу створити рахунок.`
- Running: `Створюю рахунок…`
- Verified result: `Рахунок створено.`
- Unknown result: `Результат поки невідомий. Оновіть дані перед повторною
  спробою.`
- Failure: `Не вдалося створити рахунок.`

Never infer completion from a tap, optimistic animation, AI prose, or action
start.

### Plain and actionable

- Put the important fact first.
- Prefer short sentences, active verbs, and one safe next action.
- Explain legal/technical detail only when it affects the decision.
- Avoid blame, bureaucracy, unexplained abbreviations, and false reassurance.

## Classic UI

- Buttons use exact infinitives: `Створити`, `Підтвердити`, `Скасувати`,
  `Видалити`.
- Avoid `Так`, `ОК`, `Продовжити`, or `Готово` for consequential actions.
- A state screen names the object/outcome, reason/consequence, and recovery.
- Toasts may confirm low-risk completion, but must name it:
  `Повідомлення надіслано`, never standalone `Успішно!`.
- `Закрити` closes UI; `Скасувати` changes a domain process. Never overload
  one label inside the same flow.

## AI voice and authorship

- AI messages carry `AI-помічник`.
- Human messages show name/role where needed.
- Domain updates use `Системне повідомлення`, not AI identity.
- AI never imitates staff/customer or claims independent authority.
- Separate proposal, review, confirmation, running, result, and failure states.
- The accountable user remains the actor.

AI may say:

> Я можу підготувати замовлення для перевірки.

AI must not say:

> Я вирішив підтвердити замовлення.

Before a write, show company, target, exact effect, amount/counterparty where
applicable, reversibility, and confirmation requirement. Confirmation facts
come from the authorized server summary.

Permission copy describes the user's verified role:

> У вашій ролі немає дозволу на цю дію.

Do not say AI lacks permission or suggest it has broader access.

For QES:

> Підписання КЕП відбудеться на цьому пристрої. AI-помічник не має доступу до
> вашого ключа й не може підписати документ замість вас.

## Company and role context

- Show active company by name before every company-scoped write.
- Distinguish `Staff · company`, Global discovery, and `Customer · company`.
- Context switching is explicit and never carries a staff action into another
  role/company.
- Never display tenant IDs or imply that the selected company grants access.
- Global discovery has no company authority.
- Profile/cart/chat entering a company does not create a CRM customer.
- Invite acceptance establishes only validated company context; it does not
  create a CRM row under ADR-0018's normative rule.

## States and recovery

### Loading and empty

Name the operation: `Завантажуємо каталог…`, `Створюємо рахунок…`,
`Перевіряємо підпис…`. Do not use `Зачекайте` alone.

Distinguish:

- First use: `У каталозі ще немає товарів.`
- Filtered: `За цими фільтрами нічого не знайдено.`
- Search: `За запитом «макарони» нічого не знайдено.`
- Failure: never present as genuine empty.
- Restricted/private: disclose no existence.

### Offline and synchronization

Use `Немає з’єднання`, not `Ви офлайн`.

> Немає з’єднання. Показано дані, оновлені сьогодні о 18:42.

Name pending work: `2 повідомлення очікують надсилання.` Do not imply that an
unsafe order, permission, document, or QES action is queued.

### Retry and unknown outcomes

- Offer retry only when safe.
- Preserve valid input and focus the invalid field.
- Unknown mutation outcome refreshes current state before another submit.
- Partial success names both parts:

> Документ створено, але сповіщення не надіслано.

### Errors

State what failed, safe reason, unchanged facts, and one recovery:

- Validation: `Вкажіть кількість більше нуля.`
- Permission: `У вашій ролі немає дозволу на цю дію.`
- Conflict: `Статус уже змінився. Оновіть дані.`
- Safe unavailable: `Не вдалося знайти цей об’єкт або він недоступний.`
- Unknown: `Результат поки невідомий. Оновіть дані.`
- Rate limit: `Забагато спроб. Спробуйте знову через 30 секунд.`

Never expose stack traces, provider payloads, internal codes, or foreign object
existence.

## Notifications and risky actions

Push prompts the user to open current state; it is not proof of current status.
Name object, event, and company where ambiguous. Avoid sensitive lock-screen
content and group repetitive updates.

Risk confirmations show:

- Actor and active business.
- Target and counterparty/destination.
- Amount/business effect.
- Reversibility and failure consequence.
- Exact final action.

Do not use context-free `Підтвердити дію?` or `Так / Ні`.

## Payments, documents, and QES

Launch is invoice-based; acquiring/fiscalization are deferred.

- `Рахунок створено` — the document exists.
- `Рахунок виставлено` — settlement is awaited.
- `Оплачено` — authoritative payment record reports paid.
- `Замовлення підтверджено` — an order state, not payment proof.

Never describe invoice generation as payment completion.

Launch document examples are `Договір`, `Рахунок на оплату`, and `Видаткова
накладна`, subject to later approved specs/legal review.

Use distinct states such as `Готуємо документ…`, `Документ створено`,
`Очікує підписання`, `Підписуємо на пристрої…`, `Перевіряємо підпис…`,
`Підписано КЕП`, and `Не вдалося перевірити підпис`.

Expand first use as `Кваліфікований електронний підпис (КЕП)`. Never claim
legal validity, verified safety, or key access beyond the implemented result.

## Discovery, invites, and direct links

- Use `Пошук`, `Категорії`, `Фільтри`, `Результати пошуку`.
- Never call Showzy a marketplace, social network, feed, or community.
- Unavailable: `Цей бізнес зараз недоступний.` / `Цей товар більше
  недоступний.`
- Before invite acceptance, identify company, validated effect, sign-in need,
  and destination. Do not promise CRM creation.
- Invalid invite: `Це запрошення недійсне або вже неактивне. Попросіть бізнес
  надіслати нове.`
- A link never “grants access”; it is revalidated after install/sign-in.
- Direct-link fallback: `Не вдалося відкрити цю сторінку. Вона могла стати
  недоступною.`

## Working Ukrainian glossary

### Business and people

- Company/tenant: **Бізнес** — working generic term; owner must resolve versus
  **Компанія**.
- Legal entity / sole proprietor: **Юридична особа** / **ФОП**.
- Staff/team/member: **Команда** / **Учасник команди**.
- Roles: **Власник**, **Адміністратор**, **Менеджер**, **Працівник**.
- Company-scoped customer: **Клієнт**.
- Global consumer: no role label, or **Користувач** where unavoidable.
- Customer cabinet: **Кабінет клієнта**.

### Catalog, order, and chat

- Catalog/product/variant: **Каталог**, **Товар**, **Варіант товару**.
- Cart/checkout/order: **Кошик**, **Оформлення замовлення**, **Замовлення**.
- New/confirmed/canceled: **Нове**, **Підтверджене**, **Скасоване**.
- Chat/conversation/message: **Чат**, **Розмова**, **Повідомлення**.
- Unread/archived/blocked: **Непрочитане**, **В архіві**, **Заблоковано**.

### Pricing

- Personal: **Персональна ціна**.
- Customer list: **Прайс-лист клієнта**.
- Group list: **Прайс-лист групи**.
- Default list: **Основний прайс-лист**.
- Base/effective: **Базова ціна** / **Застосована ціна**.

All pricing labels require owner/reference-user comprehension review.

### Payment, delivery, and documents

- Payment/invoice: **Оплата**, **Оплата за рахунком**, **Рахунок на оплату**.
- Delivery/address/city: **Доставка**, **Адреса доставки**, **Населений пункт**.
- Branch/locker/street: **Відділення**, **Поштомат**, **Вулиця**.
- Document/template/signing: **Документ**, **Шаблон документа**,
  **Підписання**.
- QES/sign with QES/signature: **КЕП**, **Підписати КЕП**, **Підпис**.

## Localization and accessibility

- Default locale: `uk-UA`; do not concatenate translated fragments.
- Use locale-aware Ukrainian plural forms and test 0, 1, 2, 4, 5, 11, 21, 22,
  25, and fractions.
- Use unambiguous dates, displayed timezone for consequential events, and
  absolute timestamps alongside relative time.
- Format UAH as `1 234,50 грн`; payment/document totals show two decimals.
- Never use color, icon, emoji, animation, or punctuation as the only state.
- Accessible labels name object, state, and action.
- Streaming AI provides a stable non-streaming completion.
- Preserve input and focus the first invalid field after submission.

## Prohibited patterns

- `Успішно!` without the result.
- `Щось пішло не так` without recovery.
- Raw codes, enums, IDs, permissions, or English internals.
- `Готово` before authoritative completion.
- AI claims it signed, paid, verified, or independently authorized.
- Unsupported payment, signature, encryption, or safety claims.
- `Посилання надало вам доступ`.
- `Ви офлайн`.
- English internals mixed into Ukrainian sentences.
- Copy presenting deferred/dropped functionality as launch behavior.

## Owner-resolution register

Resolve before prototype copy is frozen:

1. `Бізнес`/`Компанія`, discovery label, `Клієнт`/`Покупець`, staff roles.
2. `Варіант товару`/`Варіація` and all five pricing labels.
3. `Рахунок на оплату`/`Рахунок-фактура`, document/status vocabulary.
4. `Чат`/`Розмови` and invite wording after ADR-0018 reconciliation.
5. Formal address, `ви` capitalization, AI first person, and visible AI name.

Every resolution and comprehension finding is `internal evaluation only`, not
a claim about Ukrainian-user preference.
