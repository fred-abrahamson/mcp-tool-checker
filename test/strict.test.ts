import { describe, expect, it } from "vitest";

import { readJson, Snapshot, type SnapshotTool } from "../src/schema.ts";
import { allowsNull, dropAddedNulls, planTools, toStrictSchema } from "../src/strict.ts";

const tool = (name: string, inputSchema: Record<string, unknown>): SnapshotTool => ({
  name,
  description: `${name} description`,
  inputSchema,
});

const lookup = tool("lookup", {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid", pattern: "^[0-9a-f-]+$", description: "The id." },
    limit: { type: "integer", minimum: 1, maximum: 20 },
    kind: { type: "string", enum: ["a", "b"] },
  },
  required: ["id"],
  additionalProperties: false,
});

describe("toStrictSchema", () => {
  it("makes OpenAI optional fields required and nullable, keeping descriptions", () => {
    const result = toStrictSchema(lookup.inputSchema, "openai");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schema.required).toEqual(["id", "limit", "kind"]);
    const properties = result.schema.properties as Record<string, Record<string, unknown>>;
    expect(properties.id).toEqual({ type: "string", format: "uuid", description: "The id." });
    expect(properties.limit).toEqual({ type: ["integer", "null"], minimum: 1, maximum: 20 });
    expect(properties.kind).toEqual({ type: ["string", "null"], enum: ["a", "b", null] });
  });

  it("keeps Anthropic's required list and drops the bounds it rejects", () => {
    const result = toStrictSchema(lookup.inputSchema, "anthropic");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schema.required).toEqual(["id"]);
    const properties = result.schema.properties as Record<string, Record<string, unknown>>;
    expect(properties.limit).toEqual({ type: "integer" });
  });

  it("refuses values that accept anything and open objects", () => {
    expect(toStrictSchema(tool("t", { type: "object", properties: { x: {} } }).inputSchema, "openai")).toMatchObject({ ok: false });
    expect(
      toStrictSchema({ type: "object", properties: { x: { type: "object", additionalProperties: {} } } }, "openai"),
    ).toMatchObject({ ok: false });
  });

  it("drops an allOf made only of patterns", () => {
    const result = toStrictSchema(
      { type: "object", properties: { c: { type: "string", allOf: [{ pattern: "a" }, { pattern: "b" }] } } },
      "openai",
    );
    expect(result).toMatchObject({ ok: true });
  });
});

describe("planTools", () => {
  it("sends nothing strict to Anthropic when the set is over its optional-parameter limit", () => {
    const many = Array.from({ length: 5 }, (_, index) =>
      tool(`t${index}`, {
        type: "object",
        properties: Object.fromEntries(Array.from({ length: 6 }, (_, p) => [`p${p}`, { type: "string" }])),
      }),
    );
    const plans = planTools(many, "anthropic");
    expect(plans.every((plan) => !plan.strict)).toBe(true);
    expect(plans[0]?.reason).toContain("30 optional parameters (limit 24)");
    expect(plans[0]?.parameters).toEqual(many[0]?.inputSchema);
  });

  it("drops a dialect declaration from a schema sent non-strict", () => {
    const declared = tool("d", { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { x: {} } });
    expect(planTools([declared], "openai")[0]?.parameters).toEqual({ type: "object", properties: { x: {} } });
  });

  it("plans the example snapshot strict on both vendors", () => {
    const snapshot = readJson("snapshots/example/after.json", Snapshot);
    for (const vendor of ["openai", "anthropic"] as const) {
      const plans = planTools(snapshot.tools, vendor);
      expect(plans).toHaveLength(snapshot.tools.length);
      expect(plans.every((plan) => plan.strict)).toBe(true);
    }
  });
});

describe("dropAddedNulls", () => {
  it("removes nulls the original schema does not allow and keeps the ones it does", () => {
    const schema = {
      type: "object",
      properties: {
        a: { type: "string" },
        b: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    };
    expect(dropAddedNulls({ a: null, b: null }, schema)).toEqual({ b: null });
    expect(allowsNull({ description: "anything" })).toBe(true);
  });
});
