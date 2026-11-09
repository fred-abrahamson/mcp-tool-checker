# Contributing

Issues and pull requests are welcome. This is a small tool, and it should
stay small enough for one person, or one coding agent, to read in a sitting.

- **Before a PR:** run `npm run typecheck && npm test`. Both are offline. CI
  runs them, plus a dry run of the example suite.
- **No model calls in tests.** Tests must run without keys or a network.
- **No real data.** Snapshots and suites in this repo use the made-up
  notebook server only. Keep your own server's snapshots and suites in your
  fork or on a git-ignored path. Never include an API key, a bearer token or
  anyone's workspace content.
- **Scope.** The checker scores the first tool call and executes nothing.
  Changes that keep that shape are easy to accept. Multi-turn runs that
  execute tools are a different tool; open an issue first.
- **Prices and models** in `config/models.json` go stale. A PR that updates
  them should set `pricesCheckedOn` to the date the pricing pages were read.
