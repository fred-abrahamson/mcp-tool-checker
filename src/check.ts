// check — scores which tool each model calls first, per task and snapshot,
// and writes a markdown report with tokens and cost.
//
//   npm run check -- --suite suites/example/tasks.json --snapshots snapshots/example/before.json,snapshots/example/after.json --dry-run
//   npm run check -- --suite suites/<server>/tasks.json --snapshots snapshots/<server>/main.json,snapshots/<server>/branch.json --set tune
//
// --dry-run validates everything and prints the projected cost without
// calling any model. A paid run reads ANTHROPIC_API_KEY and OPENAI_API_KEY
// from the environment (.env) and stops before any call that could pass
// --cap-usd.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  SpendCapReached,
  SpendGuard,
  TYPICAL_OUTPUT_TOKENS,
  ZERO_USAGE,
  costUsd,
  estimateTokens,
  worstCaseUsd,
} from "./cost.ts";
import { renderReport, type TaskResult } from "./report.ts";
import { ModelsFile, Snapshot, Suite, readJson, type ModelConfig, type Task } from "./schema.ts";
import { scoreFirstCall } from "./scoring.ts";
import { planTools, type ToolPlan } from "./strict.ts";
import { suiteProblems } from "./suite.ts";
import { KEY_VARIABLES, callModel, isRequestRejected } from "./vendors.ts";

function fail(message: string): never {
  console.error(`check: ${message}`);
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    snapshots: { type: "string" },
    suite: { type: "string" },
    config: { type: "string", default: "config/models.json" },
    models: { type: "string" },
    set: { type: "string", default: "all" },
    "cap-usd": { type: "string", default: "10" },
    concurrency: { type: "string", default: "4" },
    label: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});

const suitePath = values.suite ?? fail("--suite is required: the task file, e.g. suites/example/tasks.json");
const snapshotPaths = (values.snapshots ?? fail("--snapshots is required: one or more snapshot files, comma-separated"))
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
const capUsd = Number(values["cap-usd"]);
const concurrency = Number(values.concurrency);
if (!(capUsd > 0)) fail("--cap-usd must be a positive number of USD");
if (!Number.isInteger(concurrency) || concurrency < 1) fail("--concurrency must be a positive integer");
if (!["all", "tune", "held-out"].includes(values.set)) fail("--set must be all, tune or held-out");

let suite: Suite;
let config: ModelsFile;
let snapshots: Snapshot[];
try {
  suite = readJson(suitePath, Suite);
  config = readJson(values.config, ModelsFile);
  snapshots = snapshotPaths.map((file) => readJson(file, Snapshot));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const labels = snapshots.map((snapshot) => snapshot.label);
if (new Set(labels).size !== labels.length) fail(`two snapshots share a label (${labels.join(", ")}); relabel one`);

const problems = suiteProblems(suite, snapshots);
if (problems.length > 0) fail(`the suite does not fit the snapshots:\n  ${problems.join("\n  ")}`);

const wanted = values.models?.split(",").map((id) => id.trim());
const models: ModelConfig[] = wanted
  ? wanted.map((id) => config.models.find((model) => model.id === id) ?? fail(`model ${id} is not in ${values.config}`))
  : config.models;
const tasks: Task[] = suite.tasks.filter((task) => values.set === "all" || task.set === values.set);

// ── Plan: which tools go strict, and what the run should cost ─────────────

const plans = new Map<string, ToolPlan[]>();
const strictNotes = new Map<string, Map<string, string>>();
for (const model of models) {
  const notes = new Map<string, string>();
  for (const snapshot of snapshots) {
    const plan = planTools(snapshot.tools, model.vendor);
    plans.set(`${model.id}|${snapshot.label}`, plan);
    const strict = plan.filter((tool) => tool.strict).length;
    const byReason = new Map<string, string[]>();
    for (const tool of plan.filter((candidate) => !candidate.strict)) {
      const reason = tool.reason ?? "no reason recorded";
      byReason.set(reason, [...(byReason.get(reason) ?? []), tool.name]);
    }
    const reasons = [...byReason].map(([reason, names]) =>
      names.length === plan.length ? `none, ${reason}` : `${names.join(", ")} not, ${reason}`,
    );
    notes.set(snapshot.label, [`${strict} of ${plan.length}`, ...reasons].join("; "));
  }
  strictNotes.set(model.id, notes);
}

interface Job {
  model: ModelConfig;
  snapshot: Snapshot;
  task: Task;
  tools: ToolPlan[];
  promptTokens: number;
}
const jobs: Job[] = [];
for (const model of models) {
  for (const snapshot of snapshots) {
    const tools = plans.get(`${model.id}|${snapshot.label}`) ?? [];
    const fixed = estimateTokens(JSON.stringify(tools) + snapshot.instructions);
    for (const task of tasks) {
      jobs.push({ model, snapshot, task, tools, promptTokens: fixed + estimateTokens(task.prompt) });
    }
  }
}
const projected = jobs.reduce(
  (sum, job) => sum + (job.promptTokens * job.model.price.input + TYPICAL_OUTPUT_TOKENS * job.model.price.output) / 1_000_000,
  0,
);

console.log(`Suite ${suitePath} v${suite.version}: ${tasks.length} tasks (${values.set}).`);
console.log(`Snapshots: ${labels.join(", ")}. Models: ${models.map((model) => model.id).join(", ")}.`);
for (const [model, notes] of strictNotes) {
  for (const [snapshot, note] of notes) console.log(`Strict tools, ${model} on ${snapshot}: ${note}`);
}
console.log(
  `${jobs.length} calls, projected about ${projected.toFixed(2)} USD before caching (prices checked ${config.pricesCheckedOn}), cap ${capUsd.toFixed(2)} USD.`,
);
if (projected > capUsd) fail("the projected cost is over the cap. Narrow the run or raise --cap-usd deliberately.");
if (values["dry-run"]) {
  console.log("Dry run: nothing was sent to any model.");
  process.exit(0);
}

for (const vendor of new Set(models.map((model) => model.vendor))) {
  const variable = KEY_VARIABLES[vendor];
  if (!process.env[variable]) {
    fail(`${variable} is not set. Copy .env.example to .env and put the key there (.env is git-ignored), or export it in this shell.`);
  }
}

// ── Run ────────────────────────────────────────────────────────────────────

const label = values.label ?? new Date().toISOString().replace(/[:.]/g, "-");
const runDir = path.join("runs", label);
mkdirSync(runDir, { recursive: true });
const rawFile = path.join(runDir, "raw.jsonl");
writeFileSync(
  path.join(runDir, "plans.json"),
  `${JSON.stringify(Object.fromEntries(plans), null, 2)}\n`,
);

const guard = new SpendGuard(capUsd);
const results: TaskResult[] = [];
const notes: string[] = [];
let stopReason: string | null = null;
let next = 0;

async function runJob(job: Job): Promise<void> {
  const worst = worstCaseUsd(job.model.price, job.promptTokens, config.maxOutputTokens);
  guard.reserve(worst);
  const base = {
    model: job.model.id,
    snapshot: job.snapshot.label,
    taskId: job.task.id,
    set: job.task.set,
    expectedTool: job.task.expect.tool,
  };
  try {
    const response = await callModel({
      model: job.model,
      instructions: job.snapshot.instructions,
      tools: job.tools,
      prompt: job.task.prompt,
      maxOutputTokens: config.maxOutputTokens,
    });
    const cost = costUsd(job.model.price, response.usage);
    guard.settle(worst, cost);
    const score = scoreFirstCall(response.firstCall, job.task, job.snapshot.tools);
    results.push({ ...base, score, usage: response.usage, costUsd: cost });
    appendFileSync(rawFile, `${JSON.stringify({ ...base, at: new Date().toISOString(), stop: response.stop, firstCall: response.firstCall, score, usage: response.usage, costUsd: cost, response: response.raw })}\n`);
  } catch (error) {
    // A failed call is not billed; a run never retries it on its own beyond the SDK's retries.
    guard.settle(worst, 0);
    const message = error instanceof Error ? error.message : String(error);
    if (isRequestRejected(error)) {
      stopReason = `${job.model.id} refused the request (${message}); every later call would fail the same way`;
    }
    const score = { calledTool: null, rightTool: false, validArgs: false, expectedArgs: false, pass: false, problems: [`error: ${message}`] };
    results.push({ ...base, score, usage: ZERO_USAGE, costUsd: 0, error: message });
    appendFileSync(rawFile, `${JSON.stringify({ ...base, at: new Date().toISOString(), error: message })}\n`);
  }
}

async function worker(): Promise<void> {
  while (stopReason === null && next < jobs.length) {
    const job = jobs[next];
    next += 1;
    if (!job) return;
    try {
      await runJob(job);
    } catch (error) {
      if (error instanceof SpendCapReached) {
        stopReason = error.message;
        return;
      }
      throw error;
    }
    if (results.length % 10 === 0) console.log(`… ${results.length}/${jobs.length} calls, ${guard.spentUsd.toFixed(4)} USD`);
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()));

notes.push(`Suite ${suitePath} v${suite.version}, set ${values.set}; prices checked ${config.pricesCheckedOn}; cap ${capUsd.toFixed(2)} USD.`);
for (const snapshot of snapshots) notes.push(`${snapshot.label}: ${snapshot.source}, taken ${snapshot.takenAt}.`);
if (stopReason) notes.push(`STOPPED EARLY after ${results.length} of ${jobs.length} calls: ${stopReason}.`);

const order = (result: TaskResult) => jobs.findIndex(
  (job) => job.model.id === result.model && job.snapshot.label === result.snapshot && job.task.id === result.taskId,
);
results.sort((a, b) => order(a) - order(b));
writeFileSync(path.join(runDir, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
const report = renderReport({
  title: `Tool choice: ${labels.join(" vs ")}`,
  models: models.map((model) => model.id),
  snapshots: labels,
  results,
  strictNotes,
  notes,
});
writeFileSync(path.join(runDir, "report.md"), report);
console.log(`\n${report}`);
console.log(`Raw output, scores and the report are in ${runDir}/.`);
if (stopReason) process.exit(1);
