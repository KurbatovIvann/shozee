import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scripts = path.resolve(import.meta.dirname, "../../scripts");
let workspace: string;

async function commandFailure(command: Promise<unknown>): Promise<string> {
  try {
    await command;
    expect.fail("command unexpectedly succeeded");
  } catch (error: unknown) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("stderr" in error) ||
      typeof error.stderr !== "string"
    ) {
      throw error;
    }
    return error.stderr;
  }
}

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "showzy-db-checks-"));
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("money schema lint", () => {
  it("accepts bigint _minor columns paired with currency", async () => {
    const schema = path.join(workspace, "valid");
    await mkdir(schema);
    await writeFile(
      path.join(schema, "orders.ts"),
      `export const orders = pgTable("orders", {
        total: bigint("total_minor", { mode: "bigint" }).notNull(),
        currency: char("currency", { length: 3 }).notNull(),
      });`,
    );

    await expect(
      execFileAsync("node", [
        path.join(scripts, "check-money-schema.mjs"),
        schema,
      ]),
    ).resolves.toMatchObject({ stderr: "" });
  });

  it("accepts bigint _milli quantity columns without currency", async () => {
    const schema = path.join(workspace, "valid-milli");
    await mkdir(schema);
    await writeFile(
      path.join(schema, "weights.ts"),
      `export const weights = pgTable("weights", {
        mass: bigint("mass_milli", { mode: "bigint" }).notNull(),
      });`,
    );

    await expect(
      execFileAsync("node", [
        path.join(scripts, "check-money-schema.mjs"),
        schema,
      ]),
    ).resolves.toMatchObject({ stderr: "" });
  });

  it("rejects decimal money, missing _minor suffix, and missing currency", async () => {
    const schema = path.join(workspace, "invalid");
    await mkdir(schema);
    await writeFile(
      path.join(schema, "orders.ts"),
      `export const first = pgTable("first", {
        price: numeric("price_minor"),
        currency: char("currency", { length: 3 }),
      });
      export const second = pgTable("second", {
        total: bigint("total", { mode: "bigint" }),
        currency: char("currency", { length: 3 }),
      });
      export const third = pgTable("third", {
        fee: bigint("fee_minor", { mode: "bigint" }),
      });`,
    );

    const stderr = await commandFailure(
      execFileAsync("node", [
        path.join(scripts, "check-money-schema.mjs"),
        schema,
      ]),
    );
    expect(stderr).toContain("money schema check failed");
    expect(stderr).toContain('"price_minor" must use bigint');
    expect(stderr).toContain('"total" must end in _minor');
    expect(stderr).toContain("money-bearing table must define currency");
  });

  it("accepts bigint discount_value and integer tax_rate_bp on a money table", async () => {
    const schema = path.join(workspace, "valid-kind-dependent");
    await mkdir(schema);
    await writeFile(
      path.join(schema, "order-items.ts"),
      `export const orderItems = pgTable("order_items", {
        discountKind: text("discount_kind").notNull(),
        discountValue: bigint("discount_value", { mode: "bigint" }).notNull(),
        taxRateBp: integer("tax_rate_bp").notNull(),
        priceSource: text("price_source"),
        net: bigint("net_amount_minor", { mode: "bigint" }).notNull(),
        currency: char("currency", { length: 3 }).notNull(),
      });`,
    );

    await expect(
      execFileAsync("node", [
        path.join(scripts, "check-money-schema.mjs"),
        schema,
      ]),
    ).resolves.toMatchObject({ stderr: "" });
  });

  it("rejects a non-bigint discount_value", async () => {
    const schema = path.join(workspace, "invalid-discount-value");
    await mkdir(schema);
    await writeFile(
      path.join(schema, "order-items.ts"),
      `export const orderItems = pgTable("order_items", {
        discountValue: integer("discount_value"),
        currency: char("currency", { length: 3 }).notNull(),
      });`,
    );

    const stderr = await commandFailure(
      execFileAsync("node", [
        path.join(scripts, "check-money-schema.mjs"),
        schema,
      ]),
    );
    expect(stderr).toContain(
      'kind-dependent column "discount_value" must use bigint',
    );
  });

  it("rejects _minor/_milli that are not bigint, floating columns, and new money terms", async () => {
    const schema = path.join(workspace, "invalid-extended");
    await mkdir(schema);
    await writeFile(
      path.join(schema, "payments.ts"),
      `export const refunds = pgTable("refunds", {
        refunded: numeric("refunded_minor"),
        currency: char("currency", { length: 3 }),
      });
      export const deposits = pgTable("deposits", {
        deposit: integer("deposit_minor"),
        currency: char("currency", { length: 3 }),
      });
      export const payouts = pgTable("payouts", {
        payout: doublePrecision("payout_value"),
      });
      export const extras = pgTable("extras", {
        ratio: numeric("some_ratio"),
        milli: integer("qty_milli"),
      });`,
    );

    const stderr = await commandFailure(
      execFileAsync("node", [
        path.join(scripts, "check-money-schema.mjs"),
        schema,
      ]),
    );
    expect(stderr).toContain("money schema check failed");
    expect(stderr).toContain('"refunded_minor" must use bigint');
    expect(stderr).toContain('"deposit_minor" must use bigint');
    expect(stderr).toContain('"payout_value" must end in _minor');
    expect(stderr).toContain("uses doublePrecision");
    expect(stderr).toContain("uses numeric");
    expect(stderr).toContain('"qty_milli" must use bigint');
  });
});

describe("migration drift guard", () => {
  it("passes a clean path and rejects tracked or untracked drift", async () => {
    const repository = path.join(workspace, "repository");
    const migrations = path.join(repository, "migrations");
    await mkdir(migrations, { recursive: true });
    await execFileAsync("git", ["init"], { cwd: repository });
    await writeFile(path.join(migrations, "0000.sql"), "select 1;\n");
    await execFileAsync("git", ["add", "migrations"], { cwd: repository });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Showzy Test",
        "-c",
        "user.email=test@invalid.local",
        "commit",
        "-m",
        "fixture",
      ],
      { cwd: repository },
    );
    const command = [path.join(scripts, "assert-clean-path.mjs"), "migrations"];

    await expect(
      execFileAsync("node", command, { cwd: repository }),
    ).resolves.toMatchObject({ stderr: "" });
    await writeFile(path.join(migrations, "0000.sql"), "select 2;\n");
    expect(
      await commandFailure(execFileAsync("node", command, { cwd: repository })),
    ).toContain("generated drift detected");
    await writeFile(path.join(migrations, "0000.sql"), "select 1;\n");
    await writeFile(path.join(migrations, "0001.sql"), "select 2;\n");
    expect(
      await commandFailure(execFileAsync("node", command, { cwd: repository })),
    ).toContain("generated drift detected");
  });
});

describe("staff name FTS source (SHO-528)", () => {
  it("does not add schema/search.ts", () => {
    expect(
      existsSync(path.resolve(import.meta.dirname, "../schema/search.ts")),
    ).toBe(false);
  });

  it("keeps the tsvector customType name-only and without unaccent", async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, "../schema/tsvector.ts"),
      "utf8",
    );
    expect(source).toContain("customType");
    expect(source).toContain('return "tsvector"');
    expect(source).toContain("setweight");
    expect(source).toContain("to_tsvector");
    expect(source).toContain("simple");
    const generatedSql = source.match(/sql`([^`]+)`/)?.[1] ?? "";
    expect(generatedSql).toContain("setweight");
    expect(generatedSql).toContain("to_tsvector");
    expect(generatedSql).toContain("simple");
    expect(generatedSql).not.toMatch(/unaccent/i);
  });
});
