# pr-daemon: goals and plan

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
6. A human merges. **pr-daemon never merges.**
7. Automatic cleanup (stack, worktree, branch) once the PR is merged or closed, or the label is removed.
8. All of it within a token budget.

It has to be **portable**. Any project that can start a per-branch stack from
a command can use it.

## Design

**One process on the host** (`pr-daemon serve`, Node + TypeScript). It polls
GitHub, keeps a job queue in SQLite, runs agents under a token budget, watches
stacks, and serves a status and config page on localhost.

| Decision | Why |
|---|---|
| **A single host process, not GitHub Actions.** | No runner, hook, per-repo workflow file or repo settings. Live control over each agent run: count tokens, pause, resume, stop stalled runs. |
| **Polling, not webhooks.** | Nothing on the internet needs to reach the machine, so no pfSense or tunnel for triggers. A 60s delay is fine for hour-long jobs. |
| **Acts as your GitHub user** (via `gh`). | No bot account or app. Pushes trigger your normal CI. |
| **Only allowed users trigger work.** | It reads who added the label (issue events API) and who wrote each `/pr-daemon` comment. The default allowlist is just you. |
| **Labels are dedupe keys.** | Each "label added" event triggers exactly once. Re-adding the label starts over. |
| **The project contract is two commands**: start this branch's stack (printing its URL), and stop it. A third, check, is optional. | The only project-specific part. Any shell command works, run with `bash -lc` from the worktree; the `pr-daemon-up` / `-down` / `-check` defaults are just a convention. |
| **Each branch gets a git worktree**, and the stack starts in its own process group. | Several issues can run at once, and stacks survive pr-daemon restarting. |
| **Agents run with no CI variables.** | The stack behaves exactly as it does when you run the project yourself. |
| **Agent = `claude -p --output-format stream-json`.** | Usage streams live, which drives the budget. `--session-id` / `--resume` let a paused or stalled run continue instead of starting over. |
| **pr-daemon decides "done"**, not the agent. | It re-runs the check and resumes the same session with the failure, up to N rounds. |
| **Your repository's CI is the outer check.** | The local check runs before the PR opens; GitHub's own checks know about other platforms, secrets and matrices. A red PR gets an agent, keyed by the failing commit and capped per PR, so it can't loop. |
| **The reviewer is a fresh session.** | No build context leaks in. It posts a COMMENT review, since you can't approve your own PR. |
| **One automatic revise round** after a `VERDICT: changes` review. After that, `/pr-daemon` comments. | Cheap fixes happen without you, with no endless back-and-forth between agents. |
| **Budget = a rolling token window plus a per-issue cap**, in human amounts (`"40M"`). | Matches the 5-hour subscription window. The per-issue cap protects against one runaway issue. |
| **The config is a TOML file, edited raw** in the web page and validated before it's written. | One source of truth, and your comments survive. |
| **State is rebuildable.** | GitHub holds the issue/PR truth, the disk holds the worktrees. SQLite holds the queue, the ledger and events, and running jobs resume after a crash. |

## Plan

### Phase 1: the core loop

- [x] Rewrite as a single TypeScript process: watcher, queue, scheduler, budget, agent supervisor
- [x] SQLite store (`node:sqlite`, no native modules), status page and config editor
- [x] Unit tests: amounts, durations, templates, config validation, budget window maths
- [x] Dogfood: framejs.app #99 → PR #100 through `pr-daemon serve` (build, check, PR, fresh review `VERDICT: ok`)
- [x] Resume after a failure (the same Claude session continued, then pushed and opened the PR)
- [x] `/pr-daemon` revise, paused mid-run by the per-issue cap, resumed in the same session after the cap was raised
- [x] `install-service`: `claude` works under launchd (no token needed); preview stacks survive pr-daemon restarting
- [ ] Teardown on a real PR merge or close (manual teardown verified on #96)

### Phase 2: public preview URLs

- [x] `[preview] domain`: each branch at `https://<branch>.<domain>`
- [x] pr-daemon supervises Caddy (binary or Docker), and routes are rebuilt from the stacks table and loaded via the admin API
- [x] TLS: Let's Encrypt per host (auto), Caddy's CA (internal, for testing), or plain http
- [x] `pr-daemon-up` gets `PR_DAEMON_PUBLIC_URL` / `PR_DAEMON_PUBLIC_HOST`, plus a per-repo `proxy_host`
- [x] Verified locally with `*.pr-daemon.localhost` in both modes: switching modes live, adopting a running Caddy after a restart, relaunching on port changes, stopping when the domain is unset
- [ ] A real domain with ports 80/443 forwarded (yours to set up), so Let's Encrypt can issue certificates
- [ ] framejs.app: use `PR_DAEMON_PUBLIC_URL` for its origins. Its browser code also calls nhost services on their own `*.local.nhost.run` hosts, and those need public routes too

### Phase 3: polish

- [x] Watch the repo's own checks on each PR, and fix a failing one (`[checks]`)
- [x] Preview health that tells "the app is running" from "a person can open it": two probes, up / degraded / down, with the fix named on the row
- [x] Status page: stacks first, each row expands to every address; TOML colouring and an "All options" tab in Config
- Spend per PR in the description, per-repo budgets.
- Optional access control on previews (basic auth or a shared secret), and a wildcard certificate via a DNS challenge.
- A form view of the config next to the raw TOML.
- Several machines coordinating through GitHub labels.
