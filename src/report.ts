import { addUsage, inputTokens, ZERO_USAGE, type Usage } from "./cost.ts";
import type { TaskSet } from "./schema.ts";
import type { TaskScore } from "./scoring.ts";

/**
 * Renders a run as markdown: per model, one table per task set with a row
 * per snapshot, then the tasks whose outcome changed between snapshots and a
 * pass count per expected tool. Held-out tables come first: they are the ones
 * a decision reads.
 */

export interface TaskResult {
  model: string;
  snapshot: string;
  taskId: string;
  set: TaskSet;
  expectedTool: string;
  score: TaskScore;
  usage: Usage;
  costUsd: number;
  /** Set when the call failed after retries; the task then counts as failed. */
  error?: string;
}

export interface ReportInput {
  title: string;
  models: readonly string[];
  snapshots: readonly string[];
  results: readonly TaskResult[];
  /** Per model, per snapshot: a plain line on which tools were sent strict. */
  strictNotes: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Lines printed under the title: suite, prices date, cap, anything stopped. */
  notes: readonly string[];
}

const SET_ORDER: readonly TaskSet[] = ["held-out", "tune"];

function count(results: readonly TaskResult[], pick: (score: TaskScore) => boolean): number {
  return results.filter((result) => pick(result.score)).length;
}

function fraction(part: number, whole: number): string {
  return `${part}/${whole}`;
}

function usd(value: number): string {
  return value.toFixed(4);
}

function setTable(results: readonly TaskResult[], snapshots: readonly string[]): string[] {
  const lines = [
    "| Snapshot | Pass | Right tool | Valid args | Expected args | Errors | Input tokens | Output tokens | Cost (USD) |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const snapshot of snapshots) {
    const rows = results.filter((result) => result.snapshot === snapshot);
    if (rows.length === 0) continue;
    const usage = rows.reduce((sum, row) => addUsage(sum, row.usage), ZERO_USAGE);
    const cost = rows.reduce((sum, row) => sum + row.costUsd, 0);
    lines.push(
      `| ${snapshot} | ${fraction(count(rows, (s) => s.pass), rows.length)} | ${fraction(count(rows, (s) => s.rightTool), rows.length)} | ${fraction(count(rows, (s) => s.validArgs), rows.length)} | ${fraction(count(rows, (s) => s.expectedArgs), rows.length)} | ${rows.filter((row) => row.error).length} | ${inputTokens(usage)} | ${usage.output} | ${usd(cost)} |`,
    );
  }
  return lines;
}

function outcome(result: TaskResult | undefined): string {
  if (!result) return "not run";
  if (result.error) return "error";
  return `${result.score.pass ? "pass" : "fail"} (${result.score.calledTool ?? "no call"})`;
}

function changedTasks(results: readonly TaskResult[], snapshots: readonly string[]): string[] {
  const [base, ...others] = snapshots;
  if (base === undefined || others.length === 0) return [];
  const lines: string[] = [];
  const taskIds = [...new Set(results.map((result) => result.taskId))];
  for (const other of others) {
    const changed = taskIds.flatMap((taskId) => {
      const before = results.find((result) => result.taskId === taskId && result.snapshot === base);
      const after = results.find((result) => result.taskId === taskId && result.snapshot === other);
      if (before?.score.pass === after?.score.pass) return [];
      const set = (before ?? after)?.set ?? "";
      return [`- ${taskId} (${set}): ${base} ${outcome(before)} → ${other} ${outcome(after)}`];
    });
    lines.push("", `Tasks whose outcome changed from ${base} to ${other}: ${changed.length === 0 ? "none." : ""}`, ...changed);
  }
  return lines;
}

function toolTable(results: readonly TaskResult[], snapshots: readonly string[]): string[] {
  const tools = [...new Set(results.map((result) => result.expectedTool))].sort();
  const lines = [
    `| Expected tool | ${snapshots.join(" | ")} |`,
    `|---|${snapshots.map(() => "---").join("|")}|`,
  ];
  for (const tool of tools) {
    const cells = snapshots.map((snapshot) => {
      const rows = results.filter((result) => result.expectedTool === tool && result.snapshot === snapshot);
      return fraction(count(rows, (s) => s.pass), rows.length);
    });
    lines.push(`| ${tool} | ${cells.join(" | ")} |`);
  }
  return lines;
}

export function renderReport(input: ReportInput): string {
  const lines = [`# ${input.title}`, "", ...input.notes.map((note) => `- ${note}`)];
  const total = input.results.reduce((sum, result) => sum + result.costUsd, 0);
  lines.push(`- Calls: ${input.results.length}. Total cost: ${usd(total)} USD.`);

  for (const model of input.models) {
    const forModel = input.results.filter((result) => result.model === model);
    if (forModel.length === 0) continue;
    lines.push("", `## ${model}`, "");
    for (const snapshot of input.snapshots) {
      const note = input.strictNotes.get(model)?.get(snapshot);
      if (note) lines.push(`- Strict tools on ${snapshot}: ${note}`);
    }
    for (const set of SET_ORDER) {
      const forSet = forModel.filter((result) => result.set === set);
      if (forSet.length === 0) continue;
      lines.push("", `### ${set}`, "", ...setTable(forSet, input.snapshots), ...changedTasks(forSet, input.snapshots));
    }
    lines.push("", "### Pass count per expected tool, all sets", "", ...toolTable(forModel, input.snapshots));
  }
  return `${lines.join("\n")}\n`;
}
