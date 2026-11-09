import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

import type { ArgMatcher, SnapshotTool, Task } from "./schema.ts";
import { dropAddedNulls } from "./strict.ts";

/**
 * Deterministic scoring of a model's FIRST tool call against one task. No
 * model judges anything. A task passes when all three hold:
 *   1. the right tool was called first;
 *   2. its arguments are valid against that tool's original input schema;
 *   3. every expected argument matches.
 */

/** The first tool call a response carried, as the vendor adapter read it. */
export interface FirstCall {
  tool: string;
  /** Parsed arguments, or null when the model sent JSON that did not parse. */
  args: Record<string, unknown> | null;
}

export interface TaskScore {
  calledTool: string | null;
  rightTool: boolean;
  validArgs: boolean;
  expectedArgs: boolean;
  pass: boolean;
  /** One plain line per check that failed. */
  problems: string[];
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
// ajv-formats is CommonJS: Node hands its whole exports object to a default import.
addFormatsModule.default(ajv);

const validators = new Map<string, ReturnType<typeof ajv.compile>>();

function validatorFor(tool: SnapshotTool): ReturnType<typeof ajv.compile> {
  const key = JSON.stringify(tool.inputSchema);
  let validate = validators.get(key);
  if (!validate) {
    validate = ajv.compile(tool.inputSchema);
    validators.set(key, validate);
  }
  return validate;
}

function lower(value: unknown): string | null {
  return typeof value === "string" ? value.toLowerCase() : null;
}

/** Whether one argument value satisfies its matcher. */
export function matches(value: unknown, matcher: ArgMatcher): boolean {
  if ("present" in matcher) return value !== undefined && value !== null;
  if ("absent" in matcher) return value === undefined || value === null;
  if ("equals" in matcher) return JSON.stringify(value) === JSON.stringify(matcher.equals);
  const needle = matcher.includes.toLowerCase();
  if (Array.isArray(value)) return value.some((element) => lower(element)?.includes(needle) ?? false);
  return lower(value)?.includes(needle) ?? false;
}

/**
 * Scores one first call. `tools` is the snapshot the call was made against;
 * a call naming a tool outside it is scored as the wrong tool with invalid
 * arguments.
 */
export function scoreFirstCall(
  call: FirstCall | null,
  task: Task,
  tools: readonly SnapshotTool[],
): TaskScore {
  if (!call) {
    return {
      calledTool: null,
      rightTool: false,
      validArgs: false,
      expectedArgs: false,
      pass: false,
      problems: ["no tool was called"],
    };
  }
  const problems: string[] = [];
  const rightTool = call.tool === task.expect.tool;
  if (!rightTool) problems.push(`called ${call.tool}, expected ${task.expect.tool}`);

  const tool = tools.find((candidate) => candidate.name === call.tool);
  let validArgs = false;
  let args: Record<string, unknown> | null = null;
  if (!tool) {
    problems.push(`${call.tool} is not a tool on this server`);
  } else if (call.args === null) {
    problems.push("the arguments were not valid JSON");
  } else {
    args = dropAddedNulls(call.args, tool.inputSchema) as Record<string, unknown>;
    const validate = validatorFor(tool);
    validArgs = validate(args) === true;
    if (!validArgs) {
      const detail = (validate.errors ?? [])
        .map((error) => `${error.instancePath || "(root)"} ${error.message ?? "is invalid"}`)
        .join("; ");
      problems.push(`the arguments do not match the schema: ${detail}`);
    }
  }

  let expectedArgs = false;
  if (rightTool && args !== null) {
    const misses = Object.entries(task.expect.args).filter(([name, matcher]) => !matches(args?.[name], matcher));
    expectedArgs = misses.length === 0;
    for (const [name, matcher] of misses) {
      problems.push(`${name} should be ${JSON.stringify(matcher)}, got ${JSON.stringify(args[name])}`);
    }
  }

  return {
    calledTool: call.tool,
    rightTool,
    validArgs,
    expectedArgs,
    pass: rightTool && validArgs && expectedArgs,
    problems,
  };
}
