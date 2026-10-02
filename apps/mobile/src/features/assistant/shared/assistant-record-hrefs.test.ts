import { contractModules } from "@showzy/contract";
import { describe, expect, it } from "vitest";

import {
  ASSISTANT_WRITTEN_RECORD_KINDS,
  assistantWrittenRecordKind,
} from "./assistant-record-hrefs";

interface WriteDescriptor {
  readonly name: string;
  readonly writtenRecordIdField?: string;
}

function descriptorsOf(
  group: Record<string, WriteDescriptor>,
): readonly WriteDescriptor[] {
  return Object.values(group);
}

const DESCRIPTORS: readonly WriteDescriptor[] =
  Object.values(contractModules).flatMap(descriptorsOf);

function descriptorOf(action: string): WriteDescriptor | undefined {
  return DESCRIPTORS.find((descriptor) => descriptor.name === action);
}

describe("the writes whose record the assistant offers to open", () => {
  it("each declare the result field the trace reads the id from", () => {
    for (const action of ASSISTANT_WRITTEN_RECORD_KINDS.keys()) {
      expect(descriptorOf(action)?.writtenRecordIdField, action).toEqual(
        expect.any(String),
      );
    }
  });

  it("are every client write that declares one, so neither list drifts", () => {
    const declaring = DESCRIPTORS.filter(
      (descriptor) => descriptor.writtenRecordIdField !== undefined,
    ).map((descriptor) => descriptor.name);

    expect(declaring.length).toBeGreaterThan(0);
    for (const action of declaring) {
      expect(assistantWrittenRecordKind(action), action).not.toBeNull();
    }
  });
});
