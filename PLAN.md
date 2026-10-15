# pr-demon: goals and plan

## Goal

Describe a feature in a GitHub issue, add a label, and get back a pull request
that is ready for a human to try and merge:

1. A branch named `<issue>-<very-short-summary>`.
2. A full local stack for that branch, on a machine you own.
3. An agent that builds the feature, writes tests, and keeps iterating until
   the project's checks pass.
4. A PR with a description, screenshots of UI changes, and a link to the
   running app.
5. A separate review by a second agent that sees only the PR.
6. A human merges. **pr-demon never merges.**
7. Automatic cleanup once the PR is merged or closed.
8. All of it within a token budget.

It has to be **portable**. Any project that can start a per-branch stack from
a command can use it.

## Design

**One process on the host** (`pr-demon serve`, Node + TypeScript). It polls
GitHub, keeps a job queue in SQLite, runs agents under a token budget, watches
stacks, and serves a status and config page on localhost.

| Decision | Why |
|---|---|
| **A single host process, not GitHub Actions.** | No runner, hook, per-repo workflow file or repo settings. Live control over each agent run: count tokens, pause, resume, stop stalled runs. |
| **Polling, not webhooks.** | Nothing on the internet needs to reach the machine, so no pfSense or tunnel for triggers. A 60s delay is fine for hour-long jobs. |
| **Acts as your GitHub user** (via `gh`). | No bot account or app. Pushes trigger your normal CI. |
| **Only allowed users trigger work.** | It reads who added the label (issue events API) and who wrote each `/demon` comment. The default allowlist is just you. |
| **Labels are dedupe keys.** | Each "label added" event triggers exactly once. Re-adding the label starts over. |
| **The project contract is `pr-demon-up` (prints the URL) and `pr-demon-down`.** `pr-demon-check` is optional. | The only project-specific part. Commands can be overridden per repo. |
| **Each branch gets a git worktree**, and the stack starts in its own process group. | Several issues can run at once, and stacks survive pr-demon restarting. |
| **Agents run with no CI variables.** | The stack behaves exactly like `just dev` on a laptop. |
| **Agent = `claude -p --output-format stream-json`.** | Usage streams live, which drives the budget. `--session-id` / `--resume` let a paused or stalled run continue instead of starting over. |
| **pr-demon decides "done"**, not the agent. | It re-runs the check and resumes the same session with the failure, up to N rounds. |
| **The reviewer is a fresh session.** | No build context leaks in. It posts a COMMENT review, since you can't approve your own PR. |
| **One automatic revise round** after a `VERDICT: changes` review. After that, `/demon` comments. | Cheap fixes happen without you, with no endless back-and-forth between agents. |
| **Budget = a rolling token window plus a per-issue cap**, in human amounts (`"40M"`). | Matches the 5-hour subscription window. The per-issue cap protects against one runaway issue. |
| **The config is a TOML file, edited raw** in the web page and validated before it's written. | One source of truth, and your comments survive. |
| **State is rebuildable.** | GitHub holds the issue/PR truth, the disk holds the worktrees. SQLite holds the queue, the ledger and events, and running jobs resume after a crash. |

## Plan

### Phase 1 (done in this draft)

- [x] Actions + runner prototype (bash), dogfooded on framejs.app #96 → PR #97
- [x] Rewrite as a single TypeScript process: watcher, queue, scheduler, budget, agent supervisor
- [x] SQLite store (`node:sqlite`, no native modules), status page and config editor
- [x] Unit tests: amounts, durations, templates, config validation, budget window maths
- [ ] Dogfood: framejs.app #99 through `pr-demon serve`
- [ ] Prove a budget pause and resume, and a `/demon` revise, on a real issue
- [ ] `install-service`: confirm `claude` is logged in under launchd

### Phase 2: reachable from the internet

- Caddy (one reverse proxy, `import previews/*.caddy`), with pfSense
  forwarding 443 once, or a Cloudflare Tunnel.
- `pr-demon-up` registers the branch's route, and `pr-demon-down` removes it.
- Projects need configurable public origins (auth redirects, CORS, cookies).

### Phase 3: polish

- Spend per PR in the description, per-repo budgets.
- A form view of the config next to the raw TOML.
- Several machines coordinating through GitHub labels.
