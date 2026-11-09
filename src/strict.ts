import type { SnapshotTool, Vendor } from "./schema.ts";

/**
 * Strict tool mode: each vendor can guarantee that a tool call's arguments
 * match the tool's schema, but only for a subset of JSON Schema. This module
 * converts an MCP input schema into that subset where it can, and decides per
 * tool whether it is sent strict.
 *
 * Only validation keywords are dropped (lengths, patterns, numeric bounds the
 * vendor rejects). Descriptions, names, types and enums are never touched, so
 * the text a model routes on is the server's own. Scoring validates arguments
 * against the ORIGINAL schema, so a dropped constraint still counts there.
 *
 * Limits, as each vendor's structured-output docs state them:
 *   - Anthropic: at most 20 strict tools, 24 optional parameters and 16
 *     union-typed parameters per request, summed over every strict tool.
 *     Over any of them, no tool is sent strict: a partial set would make
 *     some tools easier to call validly than others.
 *   - OpenAI: no aggregate limit, but every property must be required, so an
 *     optional one becomes required-and-nullable.
 */

export type JsonSchema = Record<string, unknown>;

export type StrictResult = { ok: true; schema: JsonSchema } | { ok: false; reason: string };

export interface ToolPlan {
  name: string;
  description: string;
  strict: boolean;
  /** The schema sent: the strict conversion when `strict`, else the original. */
  parameters: JsonSchema;
  /** Why the tool is not strict, when it is not. */
  reason?: string;
}

export const ANTHROPIC_STRICT_LIMITS = { tools: 20, optional: 24, unions: 16 } as const;

const ANTHROPIC_FORMATS = new Set([
  "date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid",
]);
const OPENAI_FORMATS = new Set([
  "date-time", "time", "date", "duration", "email", "hostname", "ipv4", "ipv6", "uuid",
]);

const DROPPED_BY_BOTH = ["minLength", "maxLength", "pattern"];
const DROPPED_BY_ANTHROPIC = [
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "maxItems",
];
const UNSUPPORTED = [
  "not", "if", "then", "else", "dependentRequired", "dependentSchemas",
  "patternProperties", "$ref", "$defs", "definitions", "oneOf",
];

function isObject(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a schema accepts JSON null. An empty schema accepts anything. */
export function allowsNull(schema: unknown): boolean {
  if (!isObject(schema)) return false;
  if (Object.keys(schema).every((key) => key === "description" || key === "title")) return true;
  const type = schema.type;
  if (type === "null" || (Array.isArray(type) && type.includes("null"))) return true;
  if (Array.isArray(schema.enum) && schema.enum.includes(null)) return true;
  if ("const" in schema && schema.const === null) return true;
  return Array.isArray(schema.anyOf) && schema.anyOf.some(allowsNull);
}

function nullable(schema: JsonSchema): JsonSchema {
  if (allowsNull(schema)) return schema;
  if (typeof schema.type === "string") {
    const out: JsonSchema = { ...schema, type: [schema.type, "null"] };
    if (Array.isArray(schema.enum)) out.enum = [...schema.enum, null];
    return out;
  }
  if (Array.isArray(schema.anyOf)) return { ...schema, anyOf: [...schema.anyOf, { type: "null" }] };
  const { description, ...rest } = schema;
  return {
    ...(description === undefined ? {} : { description }),
    anyOf: [rest, { type: "null" }],
  };
}

/** True when every member of an allOf carries only keywords this vendor drops anyway. */
function droppableAllOf(members: unknown[], dropped: Set<string>): boolean {
  return members.every((member) => isObject(member) && Object.keys(member).every((key) => dropped.has(key)));
}

function convert(schema: unknown, vendor: Vendor, path: string): StrictResult {
  if (!isObject(schema)) return { ok: false, reason: `${path} is not a schema object` };
  const dropped = new Set([...DROPPED_BY_BOTH, ...(vendor === "anthropic" ? DROPPED_BY_ANTHROPIC : [])]);
  const unsupported = UNSUPPORTED.find((key) => key in schema);
  if (unsupported) return { ok: false, reason: `${path} uses ${unsupported}` };

  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (dropped.has(key) || key === "$schema") continue;
    if (key === "format") {
      const formats = vendor === "anthropic" ? ANTHROPIC_FORMATS : OPENAI_FORMATS;
      if (typeof value === "string" && formats.has(value)) out.format = value;
      continue;
    }
    if (key === "minItems") {
      if (vendor === "openai" || value === 0 || value === 1) out.minItems = value;
      continue;
    }
    if (key === "allOf") {
      if (Array.isArray(value) && droppableAllOf(value, dropped)) continue;
      return { ok: false, reason: `${path} uses allOf` };
    }
    out[key] = value;
  }

  if (Array.isArray(out.anyOf)) {
    const members: JsonSchema[] = [];
    for (const [index, member] of out.anyOf.entries()) {
      const converted = convert(member, vendor, `${path}.anyOf[${index}]`);
      if (!converted.ok) return converted;
      members.push(converted.schema);
    }
    out.anyOf = members;
    return { ok: true, schema: out };
  }

  const types = Array.isArray(out.type) ? out.type : [out.type];
  const describesValue =
    out.type !== undefined || Array.isArray(out.enum) || "const" in out;
  if (!describesValue) return { ok: false, reason: `${path} accepts any value` };

  if (types.includes("object")) {
    if (!isObject(out.properties)) return { ok: false, reason: `${path} is an object with open keys` };
    if (out.additionalProperties !== undefined && out.additionalProperties !== false) {
      return { ok: false, reason: `${path} allows additional properties` };
    }
    const required = new Set(Array.isArray(out.required) ? out.required.map(String) : []);
    const properties: JsonSchema = {};
    for (const [name, property] of Object.entries(out.properties)) {
      const converted = convert(property, vendor, `${path}.${name}`);
      if (!converted.ok) return converted;
      properties[name] =
        vendor === "openai" && !required.has(name) ? nullable(converted.schema) : converted.schema;
    }
    out.properties = properties;
    out.additionalProperties = false;
    out.required = vendor === "openai" ? Object.keys(properties) : [...required];
  }

  if (types.includes("array")) {
    const converted = convert(out.items, vendor, `${path}[]`);
    if (!converted.ok) return converted;
    out.items = converted.schema;
  }

  return { ok: true, schema: out };
}

/**
 * Converts one tool's input schema to the vendor's strict subset.
 * Output: the converted schema, or the first construct that has no strict form.
 */
export function toStrictSchema(schema: JsonSchema, vendor: Vendor): StrictResult {
  if (schema.type !== "object") return { ok: false, reason: "the root is not an object" };
  return convert(schema, vendor, "input");
}

/** Optional and union-typed parameters in a strict schema, as Anthropic counts them. */
export function countAnthropicLimits(schema: JsonSchema): { optional: number; unions: number } {
  let optional = 0;
  let unions = 0;
  const walk = (node: unknown): void => {
    if (!isObject(node)) return;
    if (isObject(node.properties)) {
      const required = new Set(Array.isArray(node.required) ? node.required : []);
      for (const [name, property] of Object.entries(node.properties)) {
        if (!required.has(name)) optional += 1;
        if (isObject(property) && (Array.isArray(property.anyOf) || Array.isArray(property.type))) unions += 1;
        walk(property);
      }
    }
    if (Array.isArray(node.anyOf)) node.anyOf.forEach(walk);
    if (node.items !== undefined) walk(node.items);
  };
  walk(schema);
  return { optional, unions };
}

/**
 * The schema as sent when a tool is not strict. A top-level `$schema`
 * declaration is dropped: it only names a dialect, and Anthropic rejects a
 * draft-07 declaration outright.
 */
function asSent(schema: JsonSchema): JsonSchema {
  const { $schema: _declaration, ...rest } = schema;
  return rest;
}

/**
 * Decides, for one vendor, which tools are sent strict and with which schema.
 * Deterministic: the same tools always produce the same plan.
 */
export function planTools(tools: readonly SnapshotTool[], vendor: Vendor): ToolPlan[] {
  const plans: ToolPlan[] = tools.map((tool) => {
    const converted = toStrictSchema(tool.inputSchema, vendor);
    return converted.ok
      ? { name: tool.name, description: tool.description, strict: true, parameters: converted.schema }
      : {
          name: tool.name,
          description: tool.description,
          strict: false,
          parameters: asSent(tool.inputSchema),
          reason: converted.reason,
        };
  });
  if (vendor === "openai") return plans;

  const strict = plans.filter((plan) => plan.strict);
  const totals = strict.reduce(
    (sum, plan) => {
      const counted = countAnthropicLimits(plan.parameters);
      return { optional: sum.optional + counted.optional, unions: sum.unions + counted.unions };
    },
    { optional: 0, unions: 0 },
  );
  const over: string[] = [];
  if (strict.length > ANTHROPIC_STRICT_LIMITS.tools) over.push(`${strict.length} strict tools (limit ${ANTHROPIC_STRICT_LIMITS.tools})`);
  if (totals.optional > ANTHROPIC_STRICT_LIMITS.optional) over.push(`${totals.optional} optional parameters (limit ${ANTHROPIC_STRICT_LIMITS.optional})`);
  if (totals.unions > ANTHROPIC_STRICT_LIMITS.unions) over.push(`${totals.unions} union-typed parameters (limit ${ANTHROPIC_STRICT_LIMITS.unions})`);
  if (over.length === 0) return plans;

  const reason = `over the strict limits: ${over.join(", ")}`;
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    strict: false,
    parameters: asSent(tool.inputSchema),
    reason,
  }));
}

/**
 * Removes nulls a strict OpenAI call put in optional fields that do not
 * accept null, so the arguments can be judged against the original schema.
 * A null the original schema allows is kept.
 */
export function dropAddedNulls(value: unknown, schema: unknown): unknown {
  if (!isObject(value) || !isObject(schema) || !isObject(schema.properties)) return value;
  const out: JsonSchema = {};
  for (const [key, child] of Object.entries(value)) {
    const childSchema = schema.properties[key];
    if (child === null && childSchema !== undefined && !allowsNull(childSchema)) continue;
    out[key] = dropAddedNulls(child, childSchema);
  }
  return out;
}
