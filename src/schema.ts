import { readFileSync } from "node:fs";

import { z } from "zod";

/**
 * The three files a run reads, validated on load: a snapshot of one server's
 * tool surface, a suite of tasks, and the model list. Everything downstream
 * takes these inferred types, so a malformed file fails here, before any
 * model is paid.
 */

const JsonObject = z.record(z.string(), z.unknown());

export const SnapshotTool = z.object({
  name: z.string().min(1),
  description: z.string(),
  inputSchema: JsonObject,
  annotations: JsonObject.optional(),
  _meta: JsonObject.optional(),
});
export type SnapshotTool = z.infer<typeof SnapshotTool>;

/** What `initialize` and `tools/list` returned, at one moment, from one source. */
export const Snapshot = z.object({
  label: z.string().min(1),
  source: z.string().min(1),
  takenAt: z.string().min(1),
  server: z.object({ name: z.string(), version: z.string() }),
  /** The server instructions from `initialize`; empty when the server sends none. */
  instructions: z.string(),
  tools: z.array(SnapshotTool).min(1),
});
export type Snapshot = z.infer<typeof Snapshot>;

/**
 * How one expected argument is judged. String matching ignores case; on an
 * array of strings, `includes` passes when any element contains the text.
 */
export const ArgMatcher = z.union([
  z.object({ present: z.literal(true) }).strict(),
  z.object({ absent: z.literal(true) }).strict(),
  z.object({ equals: z.unknown() }).strict(),
  z.object({ includes: z.string().min(1) }).strict(),
]);
export type ArgMatcher = z.infer<typeof ArgMatcher>;

export const TaskSet = z.enum(["tune", "held-out"]);
export type TaskSet = z.infer<typeof TaskSet>;

export const Task = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  set: TaskSet,
  prompt: z.string().min(1),
  expect: z.object({
    tool: z.string().min(1),
    args: z.record(z.string(), ArgMatcher).default({}),
  }),
  /** Why this tool is the right first call, for whoever edits the task later. */
  why: z.string().min(1),
});
export type Task = z.infer<typeof Task>;

export const Suite = z.object({
  /** Bump when a held-out task changes: results before and after no longer compare. */
  version: z.number().int().positive(),
  server: z.string().min(1),
  tasks: z.array(Task).min(1),
});
export type Suite = z.infer<typeof Suite>;

export const Vendor = z.enum(["anthropic", "openai"]);
export type Vendor = z.infer<typeof Vendor>;

/** USD per million tokens. `cacheWrite` applies to Anthropic's cache writes only. */
export const Price = z.object({
  input: z.number().nonnegative(),
  cachedInput: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative().optional(),
  output: z.number().nonnegative(),
});
export type Price = z.infer<typeof Price>;

export const ModelConfig = z.object({
  id: z.string().min(1),
  vendor: Vendor,
  size: z.enum(["small", "large"]),
  price: Price,
  /** Reasoning effort passed through to the vendor; omitted means the vendor's default. */
  effort: z.enum(["low", "medium", "high"]).optional(),
});
export type ModelConfig = z.infer<typeof ModelConfig>;

export const ModelsFile = z.object({
  /** When the prices were last read from the vendors' pricing pages. */
  pricesCheckedOn: z.string().min(1),
  maxOutputTokens: z.number().int().positive(),
  models: z.array(ModelConfig).min(1),
});
export type ModelsFile = z.infer<typeof ModelsFile>;

/**
 * Reads and validates one JSON file.
 * Errors: throws naming the file, for a missing file, bad JSON or a schema mismatch.
 */
export function readJson<T>(path: string, schema: z.ZodType<T>): T {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error(`${path}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
