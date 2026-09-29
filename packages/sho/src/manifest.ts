import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

export interface FileRecord {
  readonly md5: string;
  readonly bytes: number;
}

export type FileRecords = Readonly<Record<string, FileRecord>>;

export interface Manifest {
  readonly model: string;
  readonly catalogue: string;
  readonly files: FileRecords;
  readonly source: {
    readonly repo: string;
    readonly commit: string;
    readonly runtimeVersion: string;
    readonly bundle: string;
    readonly registry: string | null;
  };
  readonly conformance: FileRecords;
  readonly updatedAt: string;
}

export const MANIFEST_FILE = "manifest.json";
export const ONNX_FILE = "model.int8.onnx";

export class ShoIntegrityError extends Error {
  override readonly name = "ShoIntegrityError";
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `the Шо model does not match ${MANIFEST_FILE}:\n  ${problems.join("\n  ")}`,
    );
    this.problems = problems;
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError(`${MANIFEST_FILE} is malformed`);
  return Object.fromEntries(Object.entries(value));
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "")
    throw new TypeError(`${MANIFEST_FILE}: ${what} is not a string`);
  return value;
}

function fileRecord(value: unknown, name: string): FileRecord {
  const file = record(value);
  const md5 = text(file["md5"], `${name}.md5`);
  const bytes = file["bytes"];
  if (!/^[0-9a-f]{32}$/.test(md5))
    throw new TypeError(`${MANIFEST_FILE}: ${name}.md5 is not an md5 digest`);
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0)
    throw new TypeError(`${MANIFEST_FILE}: ${name}.bytes is not a size`);
  return { md5, bytes };
}

function fileRecords(value: unknown, what: string): FileRecords {
  return Object.fromEntries(
    Object.entries(record(value)).map(([name, file]) => [
      name,
      fileRecord(file, `${what}.${name}`),
    ]),
  );
}

export function parseManifest(json: unknown): Manifest {
  const root = record(json);
  const source = record(root["source"]);
  const files = fileRecords(root["files"], "files");
  if (!(ONNX_FILE in files))
    throw new TypeError(`${MANIFEST_FILE}: files lack ${ONNX_FILE}`);
  const registry = source["registry"];
  if (registry !== null && typeof registry !== "string")
    throw new TypeError(
      `${MANIFEST_FILE}: source.registry is neither a status nor null`,
    );
  return {
    model: text(root["model"], "model"),
    catalogue: text(root["catalogue"], "catalogue"),
    files,
    source: {
      repo: text(source["repo"], "source.repo"),
      commit: text(source["commit"], "source.commit"),
      runtimeVersion: text(source["runtimeVersion"], "source.runtimeVersion"),
      bundle: text(source["bundle"], "source.bundle"),
      registry,
    },
    conformance: fileRecords(root["conformance"], "conformance"),
    updatedAt: text(root["updatedAt"], "updatedAt"),
  };
}

export function readManifest(root: string): Manifest {
  return parseManifest(
    JSON.parse(readFileSync(join(root, MANIFEST_FILE), "utf8")),
  );
}

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory()
        ? listFiles(path, base)
        : [relative(base, path).split("\\").join("/")];
    }),
  );
  return nested.flat();
}

export async function fileProblems(
  dir: string,
  files: FileRecords,
): Promise<string[]> {
  const problems: string[] = [];
  let present: string[];
  try {
    present = await listFiles(dir);
  } catch {
    return [`${dir} is missing`];
  }
  for (const name of present)
    if (!(name in files)) problems.push(`${name} is not in the manifest`);
  for (const [name, expected] of Object.entries(files)) {
    if (!present.includes(name)) {
      problems.push(`${name} is missing`);
      continue;
    }
    const bytes = await readFile(join(dir, name));
    const md5 = createHash("md5").update(bytes).digest("hex");
    if (md5 !== expected.md5)
      problems.push(`${name} md5 is ${md5}, expected ${expected.md5}`);
    if (bytes.length !== expected.bytes)
      problems.push(
        `${name} is ${String(bytes.length)} bytes, expected ${String(expected.bytes)}`,
      );
  }
  return problems;
}

export function modelProblems(
  dir: string,
  manifest: Pick<Manifest, "files">,
): Promise<string[]> {
  return fileProblems(dir, manifest.files);
}
