import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkModel,
  conformanceDir,
  fileProblems,
  manifest,
  modelDir,
  modelInfo,
  parseManifest,
} from "../src/index.ts";
import { modelProblems } from "../src/manifest.ts";

describe("model integrity", () => {
  it("the committed model files match manifest.json", async () => {
    expect(await checkModel()).toEqual([]);
  });

  it("the committed conformance vectors match manifest.json", async () => {
    expect(await fileProblems(conformanceDir, manifest.conformance)).toEqual(
      [],
    );
    expect(Object.keys(manifest.conformance)).toContain("commands.jsonl");
  });

  it("names the v3 bundle it was vendored from, without fp32 weights", () => {
    expect(manifest.catalogue).toBe("v3");
    expect(manifest.source).toEqual({
      repo: "system-one-uk",
      commit: "d8e39dadceb2986308c66c96fad3138f96d67ab8",
      runtimeVersion: "0.2.0",
      bundle: "demo/model-v33",
      registry: "default",
    });
    expect(modelDir.replaceAll("\\", "/")).toMatch(
      new RegExp(`/model/${manifest.model}$`),
    );
    expect(modelInfo).toEqual({
      name: manifest.model,
      md5: manifest.files["model.int8.onnx"]?.md5,
    });
    expect(Object.keys(manifest.files).sort()).toEqual([
      "calibration.json",
      "intent_labels_uk.json",
      "labels.json",
      "model.int8.onnx",
      "tokenizer.json",
    ]);
  });

  it("refuses a changed, missing or unexpected file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sho-model-"));
    try {
      await copyFile(join(modelDir, "labels.json"), join(dir, "labels.json"));
      await writeFile(join(dir, "tokenizer.json"), "{}");
      await writeFile(join(dir, "model.onnx"), "fp32");
      const problems = await modelProblems(dir, manifest);
      expect(problems).toContain("model.onnx is not in the manifest");
      expect(problems).toContain("model.int8.onnx is missing");
      expect(
        problems.some((problem) =>
          problem.startsWith(
            "tokenizer.json md5 is 99914b932bd37a50b983c5e7c90ae93b",
          ),
        ),
      ).toBe(true);
      expect(
        problems.some((problem) => problem.startsWith("labels.json")),
      ).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed manifests", () => {
    expect(() => parseManifest({ ...manifest, files: {} })).toThrow(
      /lack model.int8.onnx/,
    );
    expect(() =>
      parseManifest({
        ...manifest,
        files: { "model.int8.onnx": { md5: "x", bytes: 1 } },
      }),
    ).toThrow(/not an md5/);
    expect(() =>
      parseManifest({
        ...manifest,
        source: { ...manifest.source, registry: 3 },
      }),
    ).toThrow(/registry is neither/);
    expect(() => parseManifest({ ...manifest, catalogue: "" })).toThrow(
      /catalogue is not a string/,
    );
  });
});
