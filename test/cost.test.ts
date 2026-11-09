import { describe, expect, it } from "vitest";

import { SpendCapReached, SpendGuard, costUsd, worstCaseUsd } from "../src/cost.ts";

const price = { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 20 };

describe("cost", () => {
  it("prices each kind of token at its own rate", () => {
    expect(costUsd(price, { input: 1_000_000, cachedInput: 1_000_000, cacheWrite: 1_000_000, output: 1_000_000 })).toBeCloseTo(29.2);
    expect(worstCaseUsd(price, 1_000_000, 0)).toBe(5);
  });

  it("refuses a call whose worst case would pass the cap", () => {
    const guard = new SpendGuard(1);
    guard.reserve(0.6);
    expect(() => guard.reserve(0.6)).toThrow(SpendCapReached);
    guard.settle(0.6, 0.1);
    guard.reserve(0.6);
    expect(guard.spentUsd).toBeCloseTo(0.1);
  });
});
