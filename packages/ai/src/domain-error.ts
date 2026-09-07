/**
 * Typed catalog domain-error speech (archived / no_active_variants).
 * Protocol copy, not a surface dump (ADR-0036).
 */
import {
  catalogDomainErrorExtrasFromToolOutput,
  type CatalogDomainErrorExtras,
} from "./choice.js";
import { fillStaffAssistantCopy, type StaffAssistantLocale } from "./locale.js";

export const STAFF_ASSISTANT_CATALOG_DOMAIN_ERROR_COPY: Record<
  StaffAssistantLocale,
  {
    readonly noActiveVariants: string;
    readonly archivedProduct: string;
    readonly archivedQuery: string;
  }
> = {
  en: {
    noActiveVariants:
      "{{quoted}} has no active variants and cannot be added to an order. Name a different product, or repeat the order without it.",
    archivedProduct:
      "{{quoted}} is archived and cannot be added to an order. Name a different product, or repeat the order without it.",
    archivedQuery:
      "No sellable product matched {{quoted}}; matching products are archived and cannot be added to an order. Name a different product, or repeat the order without them.",
  },
  uk: {
    noActiveVariants:
      "{{quoted}} не має активних варіантів, в замовлення його додати не можна. Напиши інший товар або повтори замовлення без нього.",
    archivedProduct:
      "{{quoted}} в архіві, в замовлення його додати не можна. Напиши інший товар або повтори замовлення без нього.",
    archivedQuery:
      "За запитом {{quoted}} знайдено лише товари в архіві, в замовлення їх додати не можна. Напиши інший товар або повтори замовлення без них.",
  },
};

function quoteProductName(name: string, locale: StaffAssistantLocale): string {
  return locale === "uk" ? `«${name}»` : `"${name}"`;
}

export function presentCatalogDomainError(options: {
  readonly locale: StaffAssistantLocale;
  readonly extras: CatalogDomainErrorExtras;
}): string {
  const { locale, extras } = options;
  const copy = STAFF_ASSISTANT_CATALOG_DOMAIN_ERROR_COPY[locale];
  if (extras.reason === "no_active_variants") {
    return fillStaffAssistantCopy(copy.noActiveVariants, {
      quoted: quoteProductName(extras.subject.name, locale),
    });
  }
  if (extras.subject.kind === "product_name") {
    return fillStaffAssistantCopy(copy.archivedProduct, {
      quoted: quoteProductName(extras.subject.name, locale),
    });
  }
  return fillStaffAssistantCopy(copy.archivedQuery, {
    quoted: quoteProductName(extras.subject.query, locale),
  });
}

export function presentDomainErrorStaffAssistantTurn(options: {
  readonly locale: StaffAssistantLocale;
  readonly toolResults: readonly {
    readonly toolName?: string;
    readonly output: unknown;
  }[];
}): string | undefined {
  for (let index = options.toolResults.length - 1; index >= 0; index -= 1) {
    const result = options.toolResults[index];
    if (result === undefined) {
      continue;
    }
    const extras = catalogDomainErrorExtrasFromToolOutput(result.output);
    if (extras !== undefined) {
      return presentCatalogDomainError({
        locale: options.locale,
        extras,
      });
    }
  }
  return undefined;
}
