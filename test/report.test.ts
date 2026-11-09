import { describe, expect, it } from "vitest";

import { ZERO_USAGE } from "../src/cost.ts";
import { renderReport, type TaskResult } from "../src/report.ts";

const result = (snapshot: string, taskId: string, pass: boolean, calledTool: string): TaskResult => ({
  model: "small-model",
  snapshot,
  taskId,
  set: "held-out",
  expectedTool: "search_items",
  score: { calledTool, rightTool: pass, validArgs: true, expectedArgs: pass, pass, problems: [] },
  usage: { ...ZERO_USAGE, input: 1000, output: 50 },
  costUsd: 0.001,
});

describe("renderReport", () => {
  it("tabulates each snapshot and names the tasks that changed", () => {
    const report = renderReport({
      title: "Tool choice: main vs branch",
      models: ["small-model"],
      snapshots: ["main", "branch"],
      results: [
        result("main", "a", false, "list_items"),
        result("main", "b", true, "search_items"),
        result("branch", "a", true, "search_items"),
        result("branch", "b", true, "search_items"),
      ],
      strictNotes: new Map([["small-model", new Map([["main", "3 of 3"]])]]),
      notes: ["Suite v1."],
    });
    expect(report).toContain("| main | 1/2 | 1/2 | 2/2 | 1/2 | 0 | 2000 | 100 | 0.0020 |");
    expect(report).toContain("| branch | 2/2 |");
    expect(report).toContain("- a (held-out): main fail (list_items) → branch pass (search_items)");
    expect(report).toContain("| search_items | 1/2 | 2/2 |");
    expect(report).toContain("Total cost: 0.0040 USD.");
  });
});
