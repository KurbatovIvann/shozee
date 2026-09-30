import { createHash } from "node:crypto";

import type { Database } from "../src/client.js";
import { user } from "../src/schema/auth.js";
import { products, productVariants } from "../src/schema/catalog.js";
import { companies, companyMembers } from "../src/schema/companies.js";
import { companyCustomers, customerGroups } from "../src/schema/customers.js";
import { priceLists } from "../src/schema/pricing.js";

export interface DevShoBakeryProduct {
  readonly name: string;
  readonly priceMinor: number;
  readonly variants?: readonly string[];
}

const CAKE_VARIANTS = [
  "Шоколадний великий",
  "Шоколадний малий",
  "Малиновий великий",
  "Малиновий малий",
  "Лимонний великий",
  "Полуничний великий",
  "Медовий великий",
  "Ягідний великий",
] as const;

const MACARON_VARIANTS = [
  "Малиновий",
  "Лимонний",
  "Шоколадний",
  "Ванільний",
  "Фісташковий",
] as const;

export const devShoBakeryProducts: readonly DevShoBakeryProduct[] = [
  { name: "Торт", priceMinor: 85_000, variants: CAKE_VARIANTS },
  { name: "Макарон", priceMinor: 4_500, variants: MACARON_VARIANTS },
  { name: "Макаронс", priceMinor: 4_500, variants: MACARON_VARIANTS },
  { name: "Брауні", priceMinor: 9_000 },
  {
    name: "Капкейк",
    priceMinor: 7_500,
    variants: ["Ванільний", "Шоколадний"],
  },
  { name: "Еклер", priceMinor: 5_500, variants: MACARON_VARIANTS },
  { name: "Круасан", priceMinor: 6_000 },
  {
    name: "Чизкейк",
    priceMinor: 78_000,
    variants: [
      "Малиновий великий",
      "Малиновий малий",
      "Полуничний великий",
      "Карамельний великий",
    ],
  },
  { name: "Печиво", priceMinor: 32_000 },
  { name: "Кекс", priceMinor: 8_000, variants: ["Ванільний", "Шоколадний"] },
  { name: "Тістечко", priceMinor: 6_500 },
  { name: "Меренга", priceMinor: 3_500 },
  {
    name: "Пончик",
    priceMinor: 4_000,
    variants: ["Ванільний", "Шоколадний", "Полуничний", "Карамельний"],
  },
  { name: "Маффін", priceMinor: 7_000, variants: ["Шоколадний"] },
  {
    name: "Рулет",
    priceMinor: 42_000,
    variants: ["Полуничний", "Меренговий"],
  },
];

export const devShoBakeryCustomers: readonly string[] = [
  "Шерлок",
  "Альбіна",
  "Надя",
  "Катя Самбука",
  "Олег Тищенко",
  "Мосійчук",
  "Шевченко",
  "Кафе на углу",
  "Мельник",
  "Коваленко",
  "Оксана",
  "Петя Жолоб",
];

export const devShoBakeryGroups: readonly string[] = [
  "Оптові",
  "Роздріб",
  "VIP",
];

export const devShoBakeryPriceLists: readonly string[] = [
  "Оптовий",
  "Роздрібний",
  "Кав'ярні",
];

export const devShoBakeryCompany = {
  name: "Шозі Пекарня (dev)",
  slug: "sho-dev-bakery",
  prefix: "SHODEV",
} as const;

export const devShoBakeryOwner = {
  name: "Власник (dev)",
  email: "owner@sho-dev.local",
  phone: "+380931110001",
} as const;

export function devShoBakeryId(kind: string, key: string): string {
  const hex = createHash("sha256")
    .update(`sho-dev-bakery:${kind}:${key}`)
    .digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

export const devShoBakeryCompanyId = devShoBakeryId(
  "company",
  devShoBakeryCompany.slug,
);

export const devShoBakeryOwnerUserId = "sho-dev-bakery-owner";

function slugOf(name: string, index: number): string {
  const ascii = name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-");
  const trimmed = ascii.replaceAll(/(^-|-$)/g, "");
  return trimmed.length >= 2 ? trimmed : `group-${String(index + 1)}`;
}

export interface DevShoBakerySeed {
  readonly companyId: string;
  readonly ownerUserId: string;
  readonly productCount: number;
  readonly variantCount: number;
  readonly customerCount: number;
}

export async function seedDevShoBakery(
  db: Database,
  companyId: string = devShoBakeryCompanyId,
  ownerUserId: string = devShoBakeryOwnerUserId,
): Promise<DevShoBakerySeed> {
  await db
    .insert(companies)
    .values({ id: companyId, ...devShoBakeryCompany })
    .onConflictDoNothing({ target: companies.id });

  await db
    .insert(user)
    .values({
      id: ownerUserId,
      name: devShoBakeryOwner.name,
      email: devShoBakeryOwner.email,
      emailVerified: true,
      phoneNumber: devShoBakeryOwner.phone,
      phoneNumberVerified: true,
    })
    .onConflictDoNothing({ target: user.id });

  await db
    .insert(companyMembers)
    .values({
      id: devShoBakeryId("member", ownerUserId),
      companyId,
      userId: ownerUserId,
      role: "owner",
    })
    .onConflictDoNothing({ target: companyMembers.id });

  await db
    .insert(priceLists)
    .values(
      devShoBakeryPriceLists.map((name, index) => ({
        id: devShoBakeryId("priceList", name),
        companyId,
        name,
        isDefault: index === 1,
      })),
    )
    .onConflictDoNothing({ target: priceLists.id });

  await db
    .insert(customerGroups)
    .values(
      devShoBakeryGroups.map((name, index) => ({
        id: devShoBakeryId("group", name),
        companyId,
        name,
        slug: slugOf(name, index),
        sortOrder: index,
      })),
    )
    .onConflictDoNothing({ target: customerGroups.id });

  await db
    .insert(companyCustomers)
    .values(
      devShoBakeryCustomers.map((name, index) => ({
        id: devShoBakeryId("customer", name),
        companyId,
        name,
        phone: `+38093222${String(index + 1).padStart(4, "0")}`,
      })),
    )
    .onConflictDoNothing({ target: companyCustomers.id });

  await db
    .insert(products)
    .values(
      devShoBakeryProducts.map((product) => ({
        id: devShoBakeryId("product", product.name),
        companyId,
        name: product.name,
        basePriceMinor: BigInt(product.priceMinor),
      })),
    )
    .onConflictDoNothing({ target: products.id });

  const variants = devShoBakeryProducts.flatMap((product) =>
    (product.variants ?? []).map((name) => ({
      id: devShoBakeryId("variant", `${product.name}/${name}`),
      companyId,
      productId: devShoBakeryId("product", product.name),
      name,
    })),
  );
  await db
    .insert(productVariants)
    .values(variants)
    .onConflictDoNothing({ target: productVariants.id });

  return {
    companyId,
    ownerUserId,
    productCount: devShoBakeryProducts.length,
    variantCount: variants.length,
    customerCount: devShoBakeryCustomers.length,
  };
}
