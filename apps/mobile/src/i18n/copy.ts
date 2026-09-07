/**
 * Shared copy chrome used by every feature namespace. Feature files
 * spread the uk/en value objects and keep one-namespace-per-feature.
 * Do not change these strings to "unify" a namespace that already
 * differs — override the differing keys at the spread site.
 *
 * Objects live in `@showzy/copy/chrome`. `CountForms` / `selectCopy`
 * re-export so other namespaces keep importing chrome from here.
 */
export type { CountForms } from "@showzy/copy/plural";
export { selectCopy } from "@showzy/copy/locale";
export {
  formChromeEn,
  formChromeUk,
  writeErrorsEn,
  writeErrorsUk,
  type FormChromeCopy,
  type WriteErrorsCopy,
} from "@showzy/copy/chrome";
