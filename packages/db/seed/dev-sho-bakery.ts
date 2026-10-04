import { createHash } from "node:crypto";

import { eq, or } from "drizzle-orm";

import type { Database } from "../src/client.js";
import { user } from "../src/schema/auth.js";
import { products, productVariants } from "../src/schema/catalog.js";
import { companies, companyMembers } from "../src/schema/companies.js";
import { companyCustomers, customerGroups } from "../src/schema/customers.js";
import { priceLists } from "../src/schema/pricing.js";
import type { RecordCreatedVia } from "../src/schema/tenant-columns.js";

export interface DevShoBakeryProduct {
  readonly name: string;
  readonly priceMinor: number;
  readonly variants?: readonly string[];
}

export interface DevShoBakeryGroup {
  readonly name: string;
  readonly slug: string;
}

const SEEDED_VIA: RecordCreatedVia = "system";

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

export const devShoBakeryGroups: readonly DevShoBakeryGroup[] = [
  { name: "Оптові", slug: "optovi" },
  { name: "Роздріб", slug: "rozdrib" },
  { name: "VIP", slug: "vip" },
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
  phone: "+380000000001",
} as const;

export const devShoBakeryProductionRefusal =
  "dev-sho-bakery seed refuses to run with NODE_ENV=production";

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

export interface DevShoBakerySeed {
  readonly companyId: string;
  readonly ownerUserId: string;
  readonly ownerEmail: string;
  readonly ownerPhone: string | null;
  readonly productCount: number;
  readonly variantCount: number;
  readonly customerCount: number;
}

export async function seedDevShoBakery(
  db: Database,
): Promise<DevShoBakerySeed> {
  if (process.env["NODE_ENV"] === "production") {
    throw new Error(devShoBakeryProductionRefusal);
  }

  const companyId = devShoBakeryCompanyId;
  const variants = devShoBakeryProducts.flatMap((product) =>
    (product.variants ?? []).map((name) => ({
      id: devShoBakeryId("variant", `${product.name}/${name}`),
      companyId,
      productId: devShoBakeryId("product", product.name),
      name,
      createdVia: SEEDED_VIA,
    })),
  );

  const owner = await db.transaction(async (tx) => {
    await tx
      .insert(companies)
      .values({ id: companyId, ...devShoBakeryCompany })
      .onConflictDoNothing();

    const [signedUpOwner] = await tx
      .select({
        id: user.id,
        email: user.email,
        phoneNumber: user.phoneNumber,
      })
      .from(user)
      .where(
        or(
          eq(user.phoneNumber, devShoBakeryOwner.phone),
          eq(user.email, devShoBakeryOwner.email),
        ),
      )
      .orderBy(user.createdAt, user.id)
      .limit(1);

    const resolvedOwner = signedUpOwner ?? {
      id: devShoBakeryOwnerUserId,
      email: devShoBakeryOwner.email,
      phoneNumber: devShoBakeryOwner.phone,
    };

    if (signedUpOwner === undefined) {
      await tx
        .insert(user)
        .values({
          id: resolvedOwner.id,
          name: devShoBakeryOwner.name,
          email: devShoBakeryOwner.email,
          emailVerified: true,
          phoneNumber: devShoBakeryOwner.phone,
          phoneNumberVerified: true,
        })
        .onConflictDoNothing();
    }

    await tx
      .insert(companyMembers)
      .values({
        id: devShoBakeryId("member", resolvedOwner.id),
        companyId,
        userId: resolvedOwner.id,
        role: "owner",
      })
      .onConflictDoNothing();

    await tx
      .insert(priceLists)
      .values(
        devShoBakeryPriceLists.map((name, index) => ({
          id: devShoBakeryId("priceList", name),
          companyId,
          name,
          isDefault: index === 1,
          createdVia: SEEDED_VIA,
        })),
      )
      .onConflictDoNothing();

    await tx
      .insert(customerGroups)
      .values(
        devShoBakeryGroups.map((group, index) => ({
          id: devShoBakeryId("group", group.name),
          companyId,
          name: group.name,
          slug: group.slug,
          sortOrder: index,
          createdVia: SEEDED_VIA,
        })),
      )
      .onConflictDoNothing();

    await tx
      .insert(companyCustomers)
      .values(
        devShoBakeryCustomers.map((name, index) => ({
          id: devShoBakeryId("customer", name),
          companyId,
          name,
          phone: `+38000222${String(index + 1).padStart(4, "0")}`,
          createdVia: SEEDED_VIA,
        })),
      )
      .onConflictDoNothing();

    await tx
      .insert(products)
      .values(
        devShoBakeryProducts.map((product) => ({
          id: devShoBakeryId("product", product.name),
          companyId,
          name: product.name,
          basePriceMinor: BigInt(product.priceMinor),
          createdVia: SEEDED_VIA,
        })),
      )
      .onConflictDoNothing();

    await tx.insert(productVariants).values(variants).onConflictDoNothing();

    return resolvedOwner;
  });

  return {
    companyId,
    ownerUserId: owner.id,
    ownerEmail: owner.email,
    ownerPhone: owner.phoneNumber,
    productCount: devShoBakeryProducts.length,
    variantCount: variants.length,
    customerCount: devShoBakeryCustomers.length,
  };
}
