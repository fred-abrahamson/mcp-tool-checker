// snapshot — saves an MCP server's instructions and tool list to a JSON file,
// so a before and an after can be scored side by side.
//
//   npm run snapshot -- --label main --out snapshots/<server>/main.json
//   npm run snapshot -- --label branch --url http://localhost:3000/mcp --out snapshots/<server>/branch.json
//   npm run snapshot -- --label branch --command "node dist/server.js" --out snapshots/<server>/branch.json
//
// Over HTTP it reads MCP_URL and, when the server needs one, MCP_BEARER from
// the environment (.env); --url overrides MCP_URL. The bearer is sent to that
// server only and never written down. --command starts a local stdio server
// instead: the command is split on spaces, with no shell, and inherits this
// environment.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { Snapshot, type SnapshotTool } from "./schema.ts";

function fail(message: string): never {
  console.error(`snapshot: ${message}`);
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    label: { type: "string" },
    url: { type: "string" },
    command: { type: "string" },
    out: { type: "string" },
  },
});

const label = values.label ?? fail("--label is required: a short name for this snapshot, e.g. main or branch");
const out = values.out ?? fail("--out is required: the JSON file to write");

let transport: Transport;
let source: string;
if (values.command) {
  if (values.url) fail("pass --url or --command, not both");
  const [command, ...args] = values.command.split(" ").filter(Boolean);
  if (!command) fail("--command is empty");
  transport = new StdioClientTransport({ command, args, env: process.env as Record<string, string>, stderr: "inherit" });
  source = `stdio: ${values.command}`;
} else {
  const url = values.url ?? process.env.MCP_URL ?? fail("no server: set MCP_URL in .env, or pass --url or --command");
  const bearer = process.env.MCP_BEARER;
  transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {},
  });
  const target = new URL(url);
  source = `${target.origin}${target.pathname}`;
}

const client = new Client({ name: "mcp-tool-checker", version: "0.1.0" });
try {
  await client.connect(transport);
} catch (error) {
  fail(`could not connect to ${source}: ${error instanceof Error ? error.message : String(error)}`);
}

const tools: SnapshotTool[] = [];
let cursor: string | undefined;
do {
  const page = await client.listTools(cursor ? { cursor } : {});
  for (const tool of page.tools) {
    tools.push({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
      ...(tool._meta ? { _meta: tool._meta } : {}),
    });
  }
  cursor = page.nextCursor;
} while (cursor);

const server = client.getServerVersion();
const snapshot = Snapshot.parse({
  label,
  source,
  takenAt: new Date().toISOString(),
  server: { name: server?.name ?? "unknown", version: server?.version ?? "unknown" },
  instructions: client.getInstructions() ?? "",
  tools,
});
await client.close();

mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`Saved ${tools.length} tools and ${snapshot.instructions.length} characters of instructions to ${out}.`);
