import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

import type { Usage } from "./cost.ts";
import type { ModelConfig, Vendor } from "./schema.ts";
import type { FirstCall } from "./scoring.ts";
import type { ToolPlan } from "./strict.ts";

/**
 * One model call per task, the same shape on both vendors: the server
 * instructions as the system prompt, the snapshot's tools in the vendor's
 * tool format, the task prompt as the only user message, and tool choice
 * left to the model. Nothing is executed; only the first tool call is read.
 *
 * What leaves this machine: tool names, descriptions and schemas, the server
 * instructions, and the task prompt. Nothing else.
 */

export interface CallRequest {
  model: ModelConfig;
  instructions: string;
  tools: readonly ToolPlan[];
  prompt: string;
  maxOutputTokens: number;
}

export interface CallResult {
  firstCall: FirstCall | null;
  usage: Usage;
  /** The vendor's stop reason or status, verbatim. */
  stop: string;
  /** The full response, kept in the run's raw output. */
  raw: unknown;
}

/** The environment variable each vendor's key is read from. */
export const KEY_VARIABLES: Readonly<Record<Vendor, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

let anthropic: Anthropic | undefined;
let openai: OpenAI | undefined;

function asArgs(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function callAnthropic(request: CallRequest): Promise<CallResult> {
  anthropic ??= new Anthropic({ apiKey: process.env[KEY_VARIABLES.anthropic] });
  const response = await anthropic.messages.create({
    model: request.model.id,
    max_tokens: request.maxOutputTokens,
    // Tools render before the system prompt, so this one breakpoint caches both across tasks.
    ...(request.instructions
      ? { system: [{ type: "text" as const, text: request.instructions, cache_control: { type: "ephemeral" as const } }] }
      : {}),
    tools: request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters as Anthropic.Tool.InputSchema,
      ...(tool.strict ? { strict: true } : {}),
    })),
    tool_choice: { type: "auto" },
    messages: [{ role: "user", content: request.prompt }],
    ...(request.model.effort ? { output_config: { effort: request.model.effort } } : {}),
  });
  const block = response.content.find((candidate) => candidate.type === "tool_use");
  return {
    firstCall: block ? { tool: block.name, args: asArgs(block.input) } : null,
    usage: {
      input: response.usage.input_tokens,
      cachedInput: response.usage.cache_read_input_tokens ?? 0,
      cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
      output: response.usage.output_tokens,
    },
    stop: response.stop_reason ?? "unknown",
    raw: response,
  };
}

function parseArguments(text: string): Record<string, unknown> | null {
  try {
    return asArgs(JSON.parse(text));
  } catch {
    // Unparseable arguments are a scored outcome ("not valid JSON"), not a run failure.
    return null;
  }
}

async function callOpenAI(request: CallRequest): Promise<CallResult> {
  openai ??= new OpenAI({ apiKey: process.env[KEY_VARIABLES.openai] });
  const response = await openai.responses.create({
    model: request.model.id,
    ...(request.instructions ? { instructions: request.instructions } : {}),
    input: request.prompt,
    tools: request.tools.map((tool) => ({
      type: "function" as const,
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: tool.strict,
    })),
    tool_choice: "auto",
    max_output_tokens: request.maxOutputTokens,
    // Nothing is kept on the vendor's side beyond what its retention policy requires.
    store: false,
    ...(request.model.effort ? { reasoning: { effort: request.model.effort } } : {}),
  });
  const item = response.output.find((candidate) => candidate.type === "function_call");
  const usage = response.usage;
  const cached = usage?.input_tokens_details.cached_tokens ?? 0;
  return {
    firstCall: item ? { tool: item.name, args: parseArguments(item.arguments) } : null,
    usage: {
      input: (usage?.input_tokens ?? 0) - cached,
      cachedInput: cached,
      cacheWrite: 0,
      output: usage?.output_tokens ?? 0,
    },
    stop: response.incomplete_details?.reason ?? response.status ?? "unknown",
    raw: response,
  };
}

/** Makes one call. Errors: the vendor SDK's own, after its built-in retries. */
export function callModel(request: CallRequest): Promise<CallResult> {
  return request.model.vendor === "anthropic" ? callAnthropic(request) : callOpenAI(request);
}

/**
 * Whether the vendor refused the request itself (a 4xx other than a rate
 * limit): a bad key, an unknown model, a schema it will not accept. Every
 * later call would fail the same way, so the run stops.
 */
export function isRequestRejected(error: unknown): boolean {
  if (error instanceof Anthropic.APIError || error instanceof OpenAI.APIError) {
    const status = error.status;
    return typeof status === "number" && status >= 400 && status < 500 && status !== 429 && status !== 408;
  }
  return false;
}
