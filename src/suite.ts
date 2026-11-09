import type { Snapshot, Suite } from "./schema.ts";

/**
 * Checks a suite against the snapshots it will run on, before anything is
 * paid for: ids are unique, and every expected tool and expected argument
 * exists on every snapshot. A task naming a tool a snapshot lacks would score
 * zero there for a reason that has nothing to do with the descriptions.
 *
 * Output: one plain line per problem; empty when the suite is runnable.
 */
export function suiteProblems(suite: Suite, snapshots: readonly Snapshot[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const task of suite.tasks) {
    if (seen.has(task.id)) problems.push(`task id ${task.id} is used twice`);
    seen.add(task.id);
    for (const snapshot of snapshots) {
      const tool = snapshot.tools.find((candidate) => candidate.name === task.expect.tool);
      if (!tool) {
        problems.push(`${task.id}: ${snapshot.label} has no tool ${task.expect.tool}`);
        continue;
      }
      const properties = tool.inputSchema.properties;
      const names = typeof properties === "object" && properties !== null ? Object.keys(properties) : [];
      for (const arg of Object.keys(task.expect.args)) {
        if (!names.includes(arg)) {
          problems.push(`${task.id}: ${task.expect.tool} on ${snapshot.label} has no argument ${arg}`);
        }
      }
    }
  }
  return problems;
}
