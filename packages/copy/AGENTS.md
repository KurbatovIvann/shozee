# @showzy/copy — Agent Instructions

Client-safe staff copy leaf (SHO-414, SHO-474). Same class as
`@showzy/validation`: strings, `Locale`, and plural machinery. No tables,
actions, events, or React.

Feature screens keep importing `apps/*/src/i18n/<ns>`. Device bind
(`getLocales`, `initAppLocale`) stays in the app. This package is the
shared tree plus typed leftovers composed in those app files.

## Subpaths

| Subpath       | Owns                                                          |
| ------------- | ------------------------------------------------------------- |
| `./locale`    | `Locale`, `detectLocale(tag)`, `interpolate`, `selectCopy`    |
| `./plural`    | Ukrainian one/few/many and English one/`many`                 |
| `./chrome`    | Shared `FormChromeCopy` / `WriteErrorsCopy` objects           |
| `./auth`      | Byte-identical auth intersection (SHO-481)                    |
| `./orders`    | Byte-identical orders intersection (SHO-414)                  |
| `./assistant` | Wholesale mobile assistant sheet + result-surface chrome (SHO-484) |
| `./panel`     | Byte-identical panel-shell intersection (SHO-481)             |
| `./companies` | Onboarding / settings / legal / scope intersections (SHO-482) |
| `./customers` | Wholesale mobile customers list + forms (SHO-476)             |
| `./products`  | Wholesale mobile products list + form + detail (SHO-477)      |
| `./pricing`   | Wholesale mobile price-lists list + editor (SHO-478)          |
| `./documents` | Wholesale mobile documents list + create + share (SHO-479)    |

Do not add a package root barrel. Domain modules must not import this
package (ESLint `copyClientOnly`).

## Shared vs leftover

Byte-identical uk **and** en in both apps → shared here. Different
wording, or a key that exists in only one app → typed app extension.
Do not "harmonise" wording. Do not delete a mobile-only key because web
lacks it (or the reverse). Do not invent web strings "for later".

## How to add a namespace

1. Add `packages/copy/src/<ns>.ts`: types, `uk`/`en` objects, and
   `sharedXCopy(locale)` via `selectCopy`. Copy `orders.ts`, not a
   screen-shaped dump.
2. Export `./<ns>` in `package.json`. Assert uk/en key parity with
   `leafPaths` from `src/leaf-paths.ts` (not a public subpath).
3. In **each** app that already has that namespace, compose:

   ```ts
   import { sharedXCopy, type SharedXCopy } from "@showzy/copy/<ns>";

   type AppXCopy = SharedXCopy & { readonly leftover: string };
   type AppXExtension = { readonly leftover: string };

   export function xCopy(locale: Locale): AppXCopy {
     const shared = sharedXCopy(locale);
     const extra = selectCopy(locale, { uk: extraUk, en: extraEn });
     return { ...shared, ...extra };
   }
   ```

   Nested leftovers spread the nested object (`empty: { ...shared.empty,
...extra.empty }`), same as `apps/mobile/src/i18n/orders.ts`.

4. Existing `apps/*/src/i18n/<ns>.test.ts` stay green with **no
   expectation edited**. An edited expectation means a string changed —
   stop.
5. Do not mass-rewire feature screens onto `@showzy/copy`. Only the app
   `i18n/<ns>.ts` composer imports the package (plus leftover rewires
   the ticket names).

Mobile-only namespaces move wholesale so web can import later instead of
copying. Web-only keys stay in `apps/web/src/i18n/`.

Form chrome that every namespace already spreads lives in `./chrome`.
App `copy.ts` files may re-export it so existing spreads keep compiling.
Panel shell (`./panel`) is a separate tree — do not merge it into
`./chrome`.

## Leaf constraints

No React, React Native, Unistyles, Tailwind, Expo, app types
(`AuthErrorKind`, `PanelTab`), `@showzy/contract`, or auth kinds. Copy
owns the same string-literal keys; the app owns the typed kind. No
i18next or other i18n runtime.

## Tests

`*.test.ts` here: uk/en key parity and pinned shared strings. App tests
keep pinning leftovers. No DB tests.
