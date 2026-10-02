import { describe, expect, it } from "vitest";

import { shoReplicaFor } from "./routing.js";

const replicas = [
  "http://sho-1:8080",
  "http://sho-2:8080",
  "http://sho-3:8080",
  "http://sho-4:8080",
];

describe("shoReplicaFor", () => {
  it("picks the same replica for one company every time", () => {
    const companyId = "c0ffee00-0000-4000-8000-000000000001";
    const first = shoReplicaFor(replicas, companyId);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      expect(shoReplicaFor(replicas, companyId)).toBe(first);
    }
    expect(replicas).toContain(first);
  });

  it("does not depend on the order the replicas are listed in", () => {
    const companyId = "c0ffee00-0000-4000-8000-000000000002";
    const reversed = [...replicas].reverse();
    expect(shoReplicaFor(reversed, companyId)).toBe(
      shoReplicaFor(replicas, companyId),
    );
  });

  it("spreads companies across every replica", () => {
    const chosen = new Map<string, number>();
    for (let index = 0; index < 400; index += 1) {
      const replica = shoReplicaFor(replicas, `company-${String(index)}`);
      chosen.set(replica, (chosen.get(replica) ?? 0) + 1);
    }
    expect([...chosen.keys()].sort()).toEqual([...replicas].sort());
    for (const count of chosen.values()) expect(count).toBeGreaterThan(40);
  });

  it("moves only the companies the removed replica held", () => {
    const remaining = replicas.slice(0, 3);
    const moved = Array.from(
      { length: 200 },
      (_, index) => `company-${String(index)}`,
    ).filter(
      (companyId) =>
        shoReplicaFor(replicas, companyId) !==
        shoReplicaFor(remaining, companyId),
    );
    for (const companyId of moved) {
      expect(shoReplicaFor(replicas, companyId)).toBe(replicas[3]);
    }
  });
});
