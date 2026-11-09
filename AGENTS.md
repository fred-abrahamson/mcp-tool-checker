# AGENTS.md

You are probably here because someone wants to know whether their MCP
server's tool descriptions make models pick the right tool. This file has
what you need to set the checker up for their server, run it, and use it to
improve their descriptions. The README is the reference for every command
and option. This file is the playbook.

## What the checker does, in one paragraph

For each model, snapshot and task it makes one API call. The system prompt
is the server's instructions, the tools are the snapshot's tools, and the
only user message is the task prompt. Tool choice is left to the model. It
scores the **first tool call only**: is it the right tool, do the arguments
validate against the tool's schema, and are the expected arguments there? It
executes nothing, so it never touches the user's data. A report compares
snapshots per model.

## Ground rules

- **Keys stay with the user.** Model keys and any server bearer go in `.env`,
  which is git-ignored. Ask the user to fill it in themselves. Never ask them
  to paste a key into the chat, and never print or commit one.
- **Paid runs need a yes.** Always run `--dry-run` first and show the user
  the projected cost and call count. Start a real run only after they agree.
  `--cap-usd` is a hard stop; keep it at or near the projection.
- **What leaves the machine.** Tool names, descriptions, input schemas, the
  server instructions and the task prompts go to Anthropic and OpenAI. Tell
  the user that before the first paid run. A snapshot never holds tool
  results or the user's data.
- **Never put real data in tasks.** Name roles, not real people. Use made-up
  ids (any version-4 UUID). The tests reject prompts containing `@`, `Mr`,
  `Ms` or `Mrs`.
- **Held-out tasks are never used for tuning.** See below. This rule is what
  makes the final number mean anything.

## Setting it up for a new server

1. **Install.** Node 24 or later, then `npm install`. Then run
   `npm test && npm run typecheck`. Both are offline and should pass before
   you change anything.
2. **Learn how to reach the server.** Ask the user:
   - Is it remote over HTTP? You need its URL (`MCP_URL`) and, if it needs
     auth, a bearer token (`MCP_BEARER`). The checker only calls
     `initialize` and `tools/list`, so any token that may list tools will do.
   - Or does it run locally over stdio? You need the start command, e.g.
     `--command "node dist/server.js"`. It is split on spaces, with no shell.
     Wrap anything fancier in a script.
   - Does the server need OAuth with no static token? The snapshot script
     can't do that yet. Either get a token from a signed-in client and use
     it as the bearer, or extend `src/snapshot.ts`.
3. **Take the baseline snapshot.** Name the folder after the server:
   `npm run snapshot -- --label main --out snapshots/<server>/main.json`.
   Open the file and check that the tool count and the instructions match
   what the user expects.
4. **Write the suite.** Put it at `suites/<server>/tasks.json`. The format
   and the argument matchers are in the README, and
   `suites/example/tasks.json` is a worked example. Read the snapshot's
   tools first, then:
   - Ask the user which tools they plan to rewrite, and which pairs of tools
     agents mix up. Cover those first. Three tasks per tool under test is a
     good size, about two tune and one held-out.
   - Include **when-not** tasks: prompts that look like they belong to tool
     A but belong to tool B. Most of the signal comes from these.
   - Every task must have exactly one right first call. If a sensible agent
     could reasonably read something first, for example to get an id or to
     check before a write, rewrite the prompt so it already holds what the
     call needs. Otherwise the task measures caution, not descriptions.
   - Write prompts the way a user would talk, not in the tool's vocabulary.
     A prompt that names the tool tests nothing.
   - Write the held-out tasks now, **before** any run, and don't show their
     results to yourself while tuning.
5. **Validate.** `npm run check -- --suite suites/<server>/tasks.json
   --snapshots snapshots/<server>/main.json --dry-run`. This checks that
   every expected tool and argument exists, shows which tools go to each
   vendor in strict mode, and projects the cost. Fix any problems it names.
6. **Check `config/models.json`.** It names one small and one large model
   per vendor, with prices and the date they were checked. Model ids and
   prices go stale. Confirm both against the vendors' current model and
   pricing pages and update `pricesCheckedOn`. If the user has only one
   vendor's key, pass `--models` to run just those models.

## The improvement loop

This is the loop the checker was built for.

1. **Baseline:** run the full suite (`--set all`) on `main.json` once. Read
   the report with the user. Look at which tool each failed task called
   instead (`results.json` has `calledTool` per call) and look for patterns:
   one tool that swallows everything, or reads before writes.
2. **Rewrite descriptions in the user's server repo,** on a branch. Typical
   fixes:
   - Say what the tool is *for* in the first sentence.
   - Add a short "When NOT to call" line naming the right tool instead.
   - Remove instructions in the server instructions or in a description
     that send every question to one tool. Models follow "Start with X"
     literally.
   - Tell the model when no read is needed before a write.
3. **Snapshot the branch:** run it locally and snapshot it with `--label
   branch`, using `--url http://localhost:...` or `--command`.
4. **Tune:** run `--set tune` with the baseline first, then the branch:
   `--snapshots snapshots/<server>/main.json,snapshots/<server>/branch.json`.
   Repeat steps 2 to 4 as needed. Each loop costs a fraction of a full run.
5. **Decide on held-out, once.** When the user is happy with a candidate,
   run `--set held-out` on baseline and branch together. Decide from that
   table. Put it in the server PR's description with the run cost.
6. **If a second pass doesn't help, revert it.** Longer descriptions cost
   context on every request. Keep only the text that earns its place.

### Held-out discipline

- While rewriting, read `--set tune` results only.
- Never change a description because of a held-out result and then score
  it again on the same held-out tasks. If that happens, the held-out set is
  spent. Write fresh held-out tasks before the next decision.
- Never edit a held-out task after seeing its result. If one must change,
  bump the suite's `version`, say why in the commit, and don't compare
  results across versions.

## Reading results

- **One call per task:** a single task flipping between snapshots can be
  noise. Before acting on a small difference, rerun that model with a new
  `--label`.
- **First-call scoring is strict on purpose.** An agent that reads before
  a write, or lists before reading, fails the task even if it would get
  there in the end. That is usually the most common miss. Decide with the
  user whether that behaviour is a problem for their server before tuning
  against it.
- **Strict mode** has vendor limits (see the README). A large tool set is
  often sent non-strict to Anthropic models, and the report says so. That
  is expected, not a bug.
- **Vendors differ a lot.** Report per model. Don't collapse results into
  one number.
- **Some hosts cap description length** (1,024 characters is common).
  Check the longest description after a rewrite.

## Changing the checker itself

- `src/check.ts` runs and reports. `src/scoring.ts` scores the first call.
  `src/strict.ts` converts schemas to each vendor's strict format.
  `src/vendors.ts` makes the calls. `src/snapshot.ts` reads a server.
  `src/schema.ts` defines the three file formats.
- Adding a vendor means a `Vendor` value, a branch in `callModel`, and
  strict rules in `strict.ts`. Add tests next to the existing ones.
- Keep it offline-testable: `npm test` must never call a model or a server.
- Before you finish: `npm run typecheck && npm test`, plus a `--dry-run` on
  the example suite.
