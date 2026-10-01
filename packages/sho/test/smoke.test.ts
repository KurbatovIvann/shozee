import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  InputError,
  RESULT_SCHEMA,
  ShoBundleError,
  ShoIntegrityError,
  calibrationOf,
  compileContext,
  loadSho,
  loadV3Bundle,
  modelDir,
  modelInfo,
  tempered,
  type Sho,
} from "../src/index.ts";

const MAX_LOAD_MS = 30_000;
const MAX_P50_MS = 250;

const CONTEXT = compileContext({
  version: 2,
  products: [
    {
      id: "coffee",
      name: "Кава",
      variants: [
        { id: "coffee-250", name: "Кава 250 г", values: ["250 г"] },
        { id: "coffee-1kg", name: "Кава 1 кг", values: ["1 кг"] },
      ],
    },
    { id: "croissant", name: "Круасан", aliases: ["круасанчик"] },
  ],
  customers: [{ id: "olena", name: "Олена Коваль" }],
});

const PHRASE = "Створи замовлення для Олени: 2 кави і круасан";

describe("Шо smoke", () => {
  let sho: Sho | undefined;

  afterAll(async () => {
    await sho?.dispose();
  });

  it("loads the verified v3 model and parses a phrase into a Result v2", async () => {
    const started = performance.now();
    sho = await loadSho();
    const loadMs = performance.now() - started;
    expect(sho.model).toEqual(modelInfo);
    expect(sho.bundle.catalogue).toBe("v3");
    expect(sho.bundle.actions).toHaveLength(128);
    expect(sho.bundle.actions).toContain("orders.create");
    expect(loadMs).toBeLessThan(MAX_LOAD_MS);

    await sho.run({ raw: PHRASE }, { context: CONTEXT });
    const timings: number[] = [];
    for (let run = 0; run < 20; run++) {
      const begun = performance.now();
      const result = await sho.run({ raw: PHRASE }, { context: CONTEXT });
      timings.push(performance.now() - begun);
      expect(result.schema).toBe(RESULT_SCHEMA);
      const [command] = result.commands;
      expect(command?.action).toBe("orders.create");
      expect(typeof command?.domain).toBe("string");
      expect(typeof command?.verb).toBe("string");
    }
    const p50 =
      timings.sort((a, b) => a - b)[timings.length >> 1] ?? Number.NaN;
    console.log(
      `Шо ${modelInfo.name} smoke: load ${loadMs.toFixed(0)} ms, warm p50 ${p50.toFixed(1)} ms`,
    );
    expect(p50).toBeLessThan(MAX_P50_MS);
  });

  it("serves the action confidence calibrated with the bundle temperature", async () => {
    sho ??= await loadSho();
    const file: unknown = JSON.parse(
      await readFile(join(modelDir, "calibration.json"), "utf8"),
    );
    const temperature: unknown = Reflect.get(
      Object(file),
      "action_temperature",
    );
    expect(temperature).toBe(0.638);
    expect(sho.calibration.actionTemperature).toBe(temperature);
    const result = await sho.run(
      { raw: PHRASE },
      { context: CONTEXT, debug: true },
    );
    const [command] = result.commands;
    const raw = command?.debug?.actionProbabilities ?? [];
    expect(raw.length).toBe(128);
    const top = Math.max(...tempered(raw, sho.calibration.actionTemperature));
    expect(command?.confidence.action).toBeCloseTo(top, 6);
  });

  it("rejects empty input", async () => {
    sho ??= await loadSho();
    await expect(sho.run({ raw: "   " })).rejects.toBeInstanceOf(InputError);
  });

  it("refuses a recognised transcript passed as text, and reads it as raw", async () => {
    sho ??= await loadSho();
    const transcript = "Створи замовлення для Шерлока";
    const refused = await sho
      .run({ text: transcript }, { context: CONTEXT })
      .catch((thrown: unknown) => thrown);
    expect(refused).toBeInstanceOf(InputError);
    expect((refused as InputError).code).toBe("text_not_normalised");

    const result = await sho.run({ raw: transcript }, { context: CONTEXT });
    expect(result.schema).toBe(RESULT_SCHEMA);
    expect(result.commands[0]?.action).toBe("orders.create");
  });

  it("leaves an utterance without a Cyrillic word to the dialogue model", async () => {
    sho ??= await loadSho();
    const result = await sho.run(
      { raw: "Thanks a lot, that was helpful!" },
      { context: CONTEXT },
    );
    expect(result.commands).toHaveLength(1);
    const [command] = result.commands;
    expect(command?.action).toBe("none");
    expect(command?.confidence.action).toBe(0);
    expect(command?.needs).toEqual([
      { path: "text", reason: "language", blocking: false },
    ]);
  });

  it("leaves a question about the app itself to the dialogue model", async () => {
    sho ??= await loadSho();
    const result = await sho.run(
      { raw: "Підкажи, як мені додати знижку на торти в застосунку?" },
      { context: CONTEXT },
    );
    expect(result.commands).toHaveLength(1);
    const [command] = result.commands;
    expect(command?.action).toBe("none");
    expect(command?.ready).toBe(true);
    expect(command?.needs).toEqual([
      {
        path: "text",
        reason: "how_to",
        blocking: false,
        span: { text: "як мені" },
      },
    ]);
  });

  it("reads an order said after «и сделай» as a second command of the chain", async () => {
    sho ??= await loadSho();
    const result = await sho.run(
      { raw: "Создай клиента Анна Левчук и сделай ей заказ пять эклеров" },
      { context: CONTEXT },
    );
    expect(result.commands.map((command) => command.action)).toEqual([
      "customers.createCustomer",
      "orders.create",
    ]);
    const [created, order] = result.commands;
    expect(created?.ready).toBe(true);
    expect(order?.refPrevious).toEqual({ customer: 0 });
    expect(order?.ready).toBe(false);
  });

  it("blocks a write's card while a stocktake said with it is left unread", async () => {
    sho ??= await loadSho();
    const result = await sho.run(
      { raw: "Онови телефон Олені 0671234567 і зроби переоблік трьох еклерів" },
      { context: CONTEXT },
    );
    expect(result.commands).toHaveLength(1);
    const [command] = result.commands;
    expect(command?.action).toBe("customers.updateCustomer");
    expect(command?.ready).toBe(false);
    expect(command?.needs).toEqual([
      {
        path: "text",
        reason: "unparsed",
        blocking: true,
        span: { text: "зроби переоблік трьох еклерів" },
      },
    ]);
  });
});

describe("loadSho refusals", () => {
  it("refuses a tampered bundle without being asked to verify", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sho-tampered-"));
    try {
      for (const name of [
        "labels.json",
        "intent_labels_uk.json",
        "calibration.json",
      ])
        await copyFile(join(modelDir, name), join(dir, name));
      await writeFile(join(dir, "tokenizer.json"), "{}");
      const error = await loadSho({ dir }).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(ShoIntegrityError);
      expect((error as ShoIntegrityError).problems).toContain(
        "model.int8.onnx is missing",
      );
      expect(
        (error as ShoIntegrityError).problems.some((problem) =>
          problem.startsWith("tokenizer.json md5 is"),
        ),
      ).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a bundle whose labels do not say catalogue v3", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sho-v2-"));
    try {
      const labels = await readFile(join(modelDir, "labels.json"), "utf8");
      await writeFile(
        join(dir, "labels.json"),
        JSON.stringify(
          JSON.parse(labels, (name: string, value: unknown) =>
            name === "catalogue" ? undefined : value,
          ),
        ),
      );
      await copyFile(
        join(modelDir, "tokenizer.json"),
        join(dir, "tokenizer.json"),
      );
      await writeFile(join(dir, "model.int8.onnx"), "not a model");
      await expect(loadV3Bundle(dir)).rejects.toBeInstanceOf(ShoBundleError);
      await expect(loadSho({ dir, verify: false })).rejects.toThrow(
        /is not a Шо v3 bundle/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads no calibration as T = 1", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sho-uncalibrated-"));
    try {
      expect(await calibrationOf(dir)).toEqual({ actionTemperature: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loads the packaged v3 bundle", async () => {
    expect((await loadV3Bundle()).catalogue).toBe("v3");
  });
});
