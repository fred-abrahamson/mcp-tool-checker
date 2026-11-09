import { describe, expect, it } from "vitest";

import type { SnapshotTool, Task } from "../src/schema.ts";
import { matches, scoreFirstCall } from "../src/scoring.ts";

const tools: SnapshotTool[] = [
  {
    name: "search_items",
    description: "",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", minLength: 1 }, limit: { type: "integer" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "list_items",
    description: "",
    inputSchema: { type: "object", properties: { seeking: { type: "array", items: { type: "string" } } }, additionalProperties: false },
  },
];

const task: Task = {
  id: "t",
  set: "tune",
  prompt: "find freight",
  expect: { tool: "search_items", args: { query: { includes: "Freight" } } },
  why: "partial wording",
};

describe("scoreFirstCall", () => {
  it("passes the right tool with valid, expected arguments", () => {
    expect(scoreFirstCall({ tool: "search_items", args: { query: "freight notes" } }, task, tools)).toMatchObject({
      pass: true,
      problems: [],
    });
  });

  it("fails the wrong tool but still judges its arguments", () => {
    const score = scoreFirstCall({ tool: "list_items", args: { seeking: ["freight"] } }, task, tools);
    expect(score).toMatchObject({ rightTool: false, validArgs: true, expectedArgs: false, pass: false });
  });

  it("fails arguments that break the original schema", () => {
    const score = scoreFirstCall({ tool: "search_items", args: { query: "freight", extra: 1 } }, task, tools);
    expect(score).toMatchObject({ rightTool: true, validArgs: false, pass: false });
  });

  it("accepts the nulls strict mode adds to optional fields", () => {
    expect(scoreFirstCall({ tool: "search_items", args: { query: "freight", limit: null } }, task, tools).pass).toBe(true);
  });

  it("fails when no tool was called or the arguments did not parse", () => {
    expect(scoreFirstCall(null, task, tools).problems).toEqual(["no tool was called"]);
    expect(scoreFirstCall({ tool: "search_items", args: null }, task, tools).validArgs).toBe(false);
  });
});

describe("matches", () => {
  it("handles each matcher", () => {
    expect(matches(["Customer calls"], { includes: "customer" })).toBe(true);
    expect(matches(undefined, { absent: true })).toBe(true);
    expect(matches(0, { present: true })).toBe(true);
    expect(matches(50000, { equals: 50000 })).toBe(true);
    expect(matches("", { equals: "" })).toBe(true);
    expect(matches("x", { absent: true })).toBe(false);
  });
});
