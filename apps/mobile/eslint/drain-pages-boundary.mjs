export const DRAIN_INFINITE_PAGES_ALLOWLIST = [
  "src/features/customers/form/use-customer-form-lookups.ts",
  "src/features/customers/list/use-customer-lookups.ts",
  "src/features/customers/groups/use-group-form-lookups.ts",
  "src/features/customers/form/use-customer-linked-counterparties.ts",
  "src/features/documents/form/use-document-form-lookups.ts",
];

export const drainInfinitePagesImportRestriction = {
  patterns: [
    {
      regex: "hooks/use-drain-pages$",
      message:
        "useDrainInfinitePages is allowlisted to small bounded reference sets (groups, price lists, one customer's counterparties — SHO-596). A picker over an open-ended set searches the server with a debounced query and pages on scroll (golden: features/catalog/products/list/use-products-list.ts).",
    },
  ],
};

export const drainInfinitePagesBoundaryConfig = {
  files: ["src/**/*.{ts,tsx}"],
  ignores: DRAIN_INFINITE_PAGES_ALLOWLIST,
  rules: {
    "no-restricted-imports": ["error", drainInfinitePagesImportRestriction],
  },
};
