/**
 * Company scope / resolution copy shared by mobile and web (SHO-482).
 *
 * Only `loading` and `errorTitle` are byte-identical under the same
 * keys. `retry` ("Try Again" vs "Try again"), `errorDescription`, and
 * extras (`signOut`, `multipleTitle`, `backToPicker`, …) stay as typed
 * app extensions. Do not unify `multipleTitle` with web `pickerTitle`
 * even though the wording matches.
 */
import { selectCopy, type Locale } from "../locale.js";

export type SharedCompaniesScopeCopy = {
  readonly loading: string;
  readonly errorTitle: string;
};

const en: SharedCompaniesScopeCopy = {
  loading: "Loading your company",
  errorTitle: "Couldn’t load your companies",
};

const uk: SharedCompaniesScopeCopy = {
  loading: "Завантаження вашої компанії",
  errorTitle: "Не вдалося завантажити компанії",
};

export function sharedCompaniesScopeCopy(
  locale: Locale,
): SharedCompaniesScopeCopy {
  return selectCopy(locale, { uk, en });
}
