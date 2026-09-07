/**
 * Staff companies copy barrel (SHO-482).
 *
 * One public subpath; onboarding, settings, legal, and scope stay
 * distinct trees inside the package. Apps compose typed leftovers.
 */
export {
  sharedCompaniesOnboardingCopy,
  type SharedCompaniesOnboardingCopy,
  type SharedCompaniesOnboardingErrorCopy,
} from "./companies/onboarding.js";
export {
  sharedCompaniesLegalCopy,
  type SharedCompaniesLegalCopy,
  type SharedCompaniesLegalErrorCopy,
} from "./companies/legal.js";
export {
  sharedCompaniesSettingsCopy,
  type SharedCompaniesSettingsCopy,
} from "./companies/settings.js";
export {
  sharedCompaniesScopeCopy,
  type SharedCompaniesScopeCopy,
} from "./companies/scope.js";
