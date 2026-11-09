import { readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ModelsFile, readJson, Snapshot, Suite } from "../src/schema.ts";
import { suiteProblems } from "../src/suite.ts";

const suite = readJson("suites/example/tasks.json", Suite);
const before = readJson("snapshots/example/before.json", Snapshot);
const after = readJson("snapshots/example/after.json", Snapshot);

describe("the example suite", () => {
  it("fits both example snapshots", () => {
    expect(suiteProblems(suite, [before, after])).toEqual([]);
  });

  it("holds tune and held-out tasks, and covers every tool in tune", () => {
    expect(suite.tasks.filter((task) => task.set === "tune").length).toBeGreaterThan(0);
    expect(suite.tasks.filter((task) => task.set === "held-out").length).toBeGreaterThan(0);
    const tuned = new Set(suite.tasks.filter((task) => task.set === "tune").map((task) => task.expect.tool));
    expect([...tuned].sort()).toEqual(after.tools.map((tool) => tool.name).sort());
  });

  it("compares two snapshots with the same tools and schemas, only the text differs", () => {
    expect(before.tools.map((tool) => [tool.name, tool.inputSchema])).toEqual(
      after.tools.map((tool) => [tool.name, tool.inputSchema]),
    );
  });
});

describe("every committed suite", () => {
  // A suite added for another server is held to the same rules as the example.
  for (const dir of readdirSync("suites")) {
    it(`${dir}: names no real people, prompts carry ids and roles only`, () => {
      const tasks = readJson(`suites/${dir}/tasks.json`, Suite).tasks;
      for (const task of tasks) expect(task.prompt).not.toMatch(/@|\b(Mr|Ms|Mrs)\b/);
    });
  }
});

describe("suiteProblems", () => {
  it("names a missing tool and a missing argument", () => {
    const broken: Suite = {
      ...suite,
      tasks: [
        { id: "x", set: "tune" as const, prompt: "p", why: "w", expect: { tool: "get_note", args: { nope: { present: true as const } } } },
        { id: "y", set: "tune" as const, prompt: "p", why: "w", expect: { tool: "rename_note", args: {} } },
      ],
    };
    expect(suiteProblems(broken, [after])).toEqual([
      "x: get_note on after has no argument nope",
      "y: after has no tool rename_note",
    ]);
  });
});

describe("the model config", () => {
  it("names one small and one large model per vendor", () => {
    const config = readJson("config/models.json", ModelsFile);
    for (const vendor of ["anthropic", "openai"]) {
      const sizes = config.models.filter((model) => model.vendor === vendor).map((model) => model.size).sort();
      expect(sizes).toEqual(["large", "small"]);
    }
  });
});
