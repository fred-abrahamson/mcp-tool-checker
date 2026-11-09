# mcp-tool-checker

Checks how often models pick the right MCP tool, with the right arguments,
using the tool descriptions alone. Use it to compare two versions of a
server's tool text before the new text ships, for example `main` against a
branch that rewrites the descriptions. Hosts cache a connector's tool list,
so a worse description can keep being served long after you fix it.

It was built while rewriting the tool descriptions of
[Midland](https://midland.md)'s MCP server. It is small enough to read in
one sitting, and **built to be adapted by a coding agent**: point yours at
[AGENTS.md](AGENTS.md) and ask it to set the checker up for your server.

## How it scores

For each model, snapshot and task, the checker makes **one call**. The
system prompt is the server's instructions, the tools are the snapshot's
tools in the vendor's format, and the only user message is the task prompt.
Tool choice is left to the model. It scores the **first tool call only** and
executes nothing:

1. **Right tool:** the first call names the task's expected tool.
2. **Valid args:** the arguments validate against that tool's original
   input schema.
3. **Expected args:** every argument the task expects is there and matches.

A task passes when all three hold.

**What leaves your machine:** tool names, descriptions and input schemas,
the server instructions, and your made-up task prompts. They go to Anthropic
and OpenAI. Nothing else is sent: a snapshot holds only `initialize` and
`tools/list`, never a tool result.

## Quick start

Requires Node 24 or later.

```bash
npm install
npm test
```

The example in this repo is a made-up notebook server with six tools. It
has two snapshots, `before` with terse descriptions and `after` with
rewritten ones, and a 12-task suite. A dry run validates everything and
projects the cost without calling any model:

```bash
npm run check -- --suite suites/example/tasks.json --snapshots snapshots/example/before.json,snapshots/example/after.json --dry-run
```

To run it for real, copy `.env.example` to `.env`, add your
`ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, and run the same command without
`--dry-run`. The full example suite is 96 calls and costs well under 1 USD.

## Use it on your server

The short version is below. [AGENTS.md](AGENTS.md) has the full playbook:
writing good tasks, the tune and held-out loop, and how to read results.

### 1. Snapshot the server

```bash
# Remote over HTTP: reads MCP_URL and, if set, MCP_BEARER from .env
npm run snapshot -- --label main --out snapshots/myserver/main.json

# Override the URL, e.g. a local branch
npm run snapshot -- --label branch --url http://localhost:3000/mcp --out snapshots/myserver/branch.json

# Local over stdio
npm run snapshot -- --label branch --command "node dist/server.js" --out snapshots/myserver/branch.json
```

A snapshot is a JSON file holding the server's instructions and its full
tool list. A before and an after can sit side by side and be scored again
later without the server running. Any credential that may call `tools/list`
works as `MCP_BEARER`.

### 2. Write a suite

A suite is a JSON file. See `suites/example/tasks.json`:

```json
{
  "version": 1,
  "server": "notebook",
  "tasks": [
    {
      "id": "search-remembered-word",
      "set": "tune",
      "prompt": "Find my note about the vendor contract. I only remember it mentioned \"renewal\" somewhere.",
      "expect": { "tool": "search_notes", "args": { "query": { "includes": "renewal" } } },
      "why": "Remembered wording goes to search_notes, not list_notes."
    }
  ]
}
```

Each expected argument takes one matcher:

- `{"equals": <value>}`
- `{"includes": "text"}`: ignores case; on an array of strings, matches any element
- `{"present": true}`
- `{"absent": true}`

Arguments not named are checked against the schema only.

To add a task:

1. Write the prompt the way a person would ask. Name roles, never real
   people. Use made-up ids (any version-4 UUID) where a tool needs one.
2. Set `expect.tool` to the one tool that is right as the first call, and
   `expect.args` to the arguments that make it right. If two tools are
   equally right, the task is ambiguous: rewrite it.
3. Say why in `why`, in one line.
4. Put it in `tune`, unless you are writing a fresh held-out set before any
   tuning has seen it.

### 3. Run a check

Always dry-run first:

```bash
npm run check -- --suite suites/myserver/tasks.json --snapshots snapshots/myserver/main.json,snapshots/myserver/branch.json --dry-run
npm run check -- --suite suites/myserver/tasks.json --snapshots snapshots/myserver/main.json,snapshots/myserver/branch.json --set tune
```

| Option | Default | |
|---|---|---|
| `--suite` | required | The task file |
| `--snapshots` | required | Snapshot files, comma-separated. The first is the baseline the report compares against. |
| `--set` | `all` | `tune`, `held-out` or `all` |
| `--models` | every model in `config/models.json` | Model ids, comma-separated |
| `--config` | `config/models.json` | |
| `--cap-usd` | `10` | The most this run may spend |
| `--concurrency` | `4` | Calls in flight at once |
| `--label` | a timestamp | The run's folder name under `runs/` |

The report prints to the terminal. It is saved, with the raw output, in
`runs/<label>/`, which is git-ignored:

- `report.md`
- `results.json`: one score per call
- `raw.jsonl`: every response, verbatim
- `plans.json`: the exact tool definitions sent to each model

For each model, the report has:

- a table per task set, with a row per snapshot: pass, right tool, valid
  args, expected args, errors, tokens and cost
- the tasks whose outcome changed from the baseline
- the pass count for each expected tool

### Held-out tasks are never used for tuning

The tune set is for iterating, and the held-out set is the test.

- While rewriting descriptions, run and read `--set tune` only.
- Run `--set held-out` on the final candidate, against the baseline, and
  decide from that table.
- Never change a description because of a held-out result and then score
  it again on the same held-out tasks. If that happens, the held-out set is
  spent: write new held-out tasks before the next decision.
- Never edit a held-out task after seeing its result. If one must change,
  bump the suite's `version`, say why in the commit, and don't compare
  results across versions.

There is one call per task, so a single task flipping between snapshots can
be noise. Before acting on a small difference, rerun just that model with a
new `--label`.

## Cost and the cap

The dry run projects the cost before prompt caching. The cap is checked
before every call against that call's worst case, so a run can't exceed
it. A run that would exceed it stops and reports what it has so far.

Cost scales with tool count × tasks × snapshots × models. As a reference
point, a 17-tool server with 30 tasks, 2 snapshots and 4 models (240 calls)
projected about 6 USD and cost less than a quarter of that once cached.

Prices live in `config/models.json`, with the date they were read. They go
stale over time. Re-read the vendors' pricing pages before a paid run, and
update the prices and `pricesCheckedOn` together.

## Models and strict mode

`config/models.json` names one small and one large model per vendor. To
change a model, edit that file, not the code.

Tools are sent in strict mode where the vendor offers it, so a model's
arguments are held to the schema. The only things dropped from what is sent
are validation keywords the vendor does not support, such as lengths,
patterns and some numeric bounds. Names, descriptions, types and enums are
sent exactly as the server wrote them, and scoring still validates against
the original schema.

- **Anthropic** allows at most 20 strict tools, 24 optional parameters and
  16 union-typed parameters per request. If a tool set goes over any of
  these, no tool is sent strict.
- **OpenAI** strict mode requires every property, so optional properties are
  sent as required and nullable. Those nulls are removed before scoring. A
  tool with a free-form value can't be strict.

The dry run prints the strict-mode plan for each model and snapshot, and the
report repeats it.

## Development

```bash
npm test           # offline: scoring, strict conversion, the cost cap, the example suite
npm run typecheck
```

See [CONTRIBUTING.md](CONTRIBUTING.md). MIT licensed, see [LICENSE](LICENSE).
