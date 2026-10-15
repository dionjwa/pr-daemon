# pr-daemon: context for agents working on this repo

Read this first (then journal.md for the history and next steps). It records the goals, the owner's decisions, how the code fits
together, and what we learned the hard way. User-facing docs are in README.md
(keep that one simple and step-by-step); the roadmap is in PLAN.md.

## What it is

Label a GitHub issue `agent`, get a pull request. One long-running process on
the owner's machine (`pr-daemon serve`):

1. polls GitHub for issues that just got the `agent` label, checking **who** added it
2. creates a worktree on a branch `<issue>-<short-kebab-summary>`
3. starts that branch's full stack (`just pr-daemon-up`, which prints the local URL)
4. runs headless Claude Code to build the feature and tests, then re-runs the
   project's check (`just pr-daemon-check`) and resumes the same session to fix
   failures, up to N rounds
5. pushes and opens a PR with a description, screenshots and a preview link
6. runs a **fresh** Claude session to review the PR (it sees only the PR), with
   one automatic revise round if the verdict is `changes`
7. `/pr-daemon <feedback>` comments on the PR trigger further revisions
8. when the PR or issue closes: `just pr-daemon-down`, remove the worktree, clear labels
9. with `[preview] domain` set: runs Caddy so each branch is at
   `https://<branch>.<domain>`

All agent work happens within a token budget (rolling window plus per-issue cap).
A human always merges.

## The owner's decisions (don't change these without asking)

- **One host process.** Not GitHub Actions, and not a self-hosted runner: both
  were tried and dropped (too much per-repo setup, no control over token use).
  Don't reintroduce them.
- **Node + TypeScript**, run directly (Node ≥ 23.6 strips types; no build
  step). Only syntax that can be stripped: no enums, namespaces or parameter
  properties, and imports use `.ts` extensions.
- **SQLite via built-in `node:sqlite`** for jobs, the token ledger, stacks,
  events and kv. No native modules.
- **Config is one TOML file** (`~/.pr-daemon/config.toml`). The status page
  edits the **raw text**, so comments survive. It's validated before it's
  written, and changes apply live.
- **Status page** on `127.0.0.1:7377` only: vanilla HTML in `src/ui.html`, no
  framework, no build, **no `alert`/`confirm` dialogs** (click twice to
  confirm). Three tabs, routed off `location.hash`: Status, Setup (the line to
  paste into an agent's chat, built from `location.origin` so it always names
  the address you reached the page on) and Config (the raw TOML, plus where
  everything lives on disk).
- **Acts as the owner's own GitHub user** through `gh`. No bot account and no
  GitHub App. Consequences: you can't *approve* your own PR, so the reviewer
  posts a COMMENT review and the owner merges. Pushes trigger the project's
  normal CI.
- **Only allowed users trigger work**: the actor of the `labeled` event and the
  author of `/pr-daemon` comments must be in `allowed_users` (default: the gh user).
- **Trigger label is `agent`.** Status labels are `agent:working`,
  `agent:in-review`, `agent:paused` and `agent:failed`.
- **Budget:** optional tokens per rolling window (default `5h`, one Claude
  subscription window), in human amounts (`"40M"`), plus an optional
  `per_issue` cap. Hitting the window limit pauses and auto-resumes. Hitting
  the per-issue cap pauses until a human presses Resume.
- **Portable:** a project only adds `pr-daemon-up` (start in the background,
  print the URL last) and `pr-daemon-down`. `pr-daemon-check` is optional. Every
  command can be overridden per repo.
- **Public previews:** the owner routes `*.<domain>` (DNS plus ports 80/443) to
  the machine. pr-daemon owns Caddy (binary or Docker) and the routing.
- **The repo will be public.** No secrets, hostnames, IPs or personal paths in
  code or docs.
- Commands in docs are `just` recipes where a project is involved. Keep the
  README step-by-step and plain.

## Code map (`src/`)

| File | Responsibility |
|---|---|
| `cli.ts` | Commands: `serve`, `status`, `doctor`, `run <kind> <repo> <n>`, `install-service` / `uninstall-service` (launchd plist / systemd user unit) |
| `daemon.ts` | The process: GitHub poll loop, scheduler (priority, concurrency, per-branch locks, budget gate), job launch and error→state mapping, page actions, `status()` JSON |
| `pipeline.ts` | The jobs (`JOBS`): `build`, `review`, `revise`, `teardown`, `restart`. `agentStep()` runs Claude under the budget. Prompt templates are rendered from `prompts/*.md` with a single-pass `{{VAR}}` |
| `agent.ts` | Spawns `claude -p --output-format stream-json --verbose`, with `--session-id` for new sessions and `--resume` to continue. Live usage deltas, tool-activity lines, stall timer, kill switch, rate-limit detection |
| `budget.ts` | Rolling-window sum, per-issue sum, `gate()`, and when the window frees up |
| `proxy.ts` | Caddy supervisor. `caddyConfig()` is pure (unit-tested): routes are rebuilt from the stacks table every 5s and loaded via the admin API when the hash changes |
| `db.ts` | Schema plus `Store` (jobs, usage, stacks, events, kv) |
| `gh.ts` / `git.ts` / `stack.ts` | Wrappers for `gh` (as the user), the cached clone plus worktrees plus the screenshot branch, and the project's up/down/check commands |
| `config.ts` | `DEFAULT_TOML` (the documented template), `parseConfig()` with readable errors, atomic save |
| `web.ts` / `ui.html` | The localhost API (Host check; writes need `X-PR-Daemon: 1`) and the page |
| `setup.ts` / `docs/setup.md` | `paths()` (the runtime directories) and `setupDoc()`: the project contract with this machine's real paths and commands filled in, served as plain text at `GET /setup` and printed by `pr-daemon setup` |
| `util.ts` | Amounts/durations, `run`/`sh`/`must`, `cleanEnv` |

The repo's own `justfile` wraps the CLI plus the dev commands; `examples/justfile` is the contract a target project implements.

**Job lifecycle:** `queued → running → done | failed | cancelled | paused`, and
`ignored` for disallowed triggers. Each job has a unique `trigger_key`
(label event id, comment id, …), so a GitHub event triggers exactly once. A
paused or crashed job keeps its `session_id`, and resuming continues that
Claude session. On startup, `running` jobs are re-queued.

**Runtime files:** everything lives in `~/.pr-daemon/`: `config.toml`,
`pr-daemon.db`, `pr-daemon.log`, `repos/` (cached clones), `worktrees/`, `out/`
(prompts, agent `*.jsonl` logs, PR text, screenshots), `assets/` (the
screenshot branch clone), `caddy/`.

## Develop and test

Everything is a `just` recipe (`just` alone lists them and prints the
getting-started checklist):

```bash
just                          # the recipe list; node modules install on first use
just dev                      # run it here, restarting on every change to src/
just check                    # tsc --noEmit
just test                     # node --test src/*.test.ts (pure logic: amounts, config, budget, Caddy config)
just ci                       # both, what .github/workflows/ci.yml runs
just doctor                   # tools, logins, config, preview proxy
just run build owner/repo 42  # one job inline, no daemon needed
just restart                  # restart the installed service after code changes (launchd / systemd)
just logs                     # tail -f ~/.pr-daemon/pr-daemon.log
just db 'select * from jobs limit 5;'
just contract                 # print examples/justfile, the two recipes a project adds
```

- The service runs the code from this checkout, so restart it to pick up
  changes. Jobs that were running are re-queued and resume their Claude
  sessions.
- **Testing previews without a real domain:** `[preview] domain =
  "pr-daemon.localhost"`, `tls = "internal"`, `http_port = 8080`,
  `https_port = 8443`, then `curl -sk https://<branch>.pr-daemon.localhost:8443/`.
- **Driving the API from zsh:** zsh doesn't word-split unquoted variables, so
  write headers out: `-H 'x-pr-daemon: 1'`.
- **Screenshots of the status page:** use Playwright with an already-installed
  Chromium from `~/Library/Caches/ms-playwright`.

## Gotchas we hit (don't relearn these)

- **stream-json usage repeats** once per content block of the same assistant
  message: dedupe by `message.id` and count only deltas.
- **Keep Claude's stderr out of the JSON log.** The first line is a non-JSON
  warning, and it broke `jq` parsing of the result.
- **Don't `git add -A` the agent's leftovers.** Tool caches (e.g.
  `.impeccable/hook.cache.json`) were committed into a PR once. Commit tracked
  changes only (`add -u`) and log untracked files.
- **Pushes touching `.github/workflows/` are rejected** because the owner's gh
  login lacks the `workflow` scope. That's a good guard (the agent can't
  rewrite CI). `git.push()` explains it. It also bit us when a branch was
  based on a commit that had a workflow file which was later deleted
  upstream: rebasing onto the current base fixed it.
- **`gh issue edit --remove-label` fails the whole command** if one label
  doesn't exist. `setStatus()` uses the REST API and only removes labels the
  issue has.
- **launchd:** `claude` works headless when HOME and PATH are set (the plist
  does this; no OAuth token needed). `AbandonProcessGroup` plus starting
  stacks `detached` means preview stacks survive pr-daemon restarting.
- **Caddy is tied to the process:** `serve` traps SIGINT/SIGTERM and calls
  `Daemon.shutdown()` → `Proxy.shutdown()`, which stops the Caddy it manages
  (admin `/stop`, or `docker rm -f`) and sets a `stopped` flag so `tick()`
  can't start another. So a restart costs a few seconds of preview downtime.
  Caddy still runs `detached`, so a signal can't kill it mid-request; if
  pr-daemon is SIGKILLed, the surviving Caddy is adopted on the next start.
- **Caddy admin API vs Node `fetch`:** undici sends `Sec-Fetch-Mode: cors`, and
  Caddy then refuses requests without an allowed `Origin`. `proxy.ts` sends
  `Origin: http://<admin>` and lists it in `admin.origins`.
- **Caddy ports are fixed at launch** (Docker publishes them). Changing
  ports, mode, admin address or TLS mode means stop plus relaunch: the
  `proxy:launched` kv key. The first Docker start can take a minute
  (image pull).
- **Unhandled promise rejections crash Node.** Handlers that call GitHub use
  `.catch(() => {})`, and `serve` logs any stray rejection instead of dying.
- **Agents read the target project's CLAUDE.md and skills** from the worktree.
  Project knowledge belongs there, not in pr-daemon's prompts.
- **`up` / `down` / `check` are arbitrary shell command lines**, run as
  `bash -lc <line>` by `stack.ts` from the worktree root. `just` is only the
  default spelling. The one just-aware bit is `missingRecipe()`: a command of
  exactly `just <recipe>` whose recipe doesn't exist counts as "not
  configured" rather than a failure. Keep docs saying "command", not "recipe".
- **The project contract lives in `docs/setup.md`**, rendered through the same
  `{{VAR}}` pass as the prompts. Change it there, not in the README — the
  README links to it and `GET /setup` serves it to agents.

## Dogfood setup (the owner's machine)

- **Target repo:** `metapages/framejs.app` (Deno Fresh worker plus nhost
  backend; local checkout `../framejs-nhost3`). Its recipes live on branch
  **`pr-demon-setup`** (not yet merged to `main`), so the owner's config has
  `base = "pr-demon-setup"` for that repo. Remove that line after the merge.
  **That branch still has the old `pr-demon-*` recipe names** (it predates the
  rename), so until they're renamed to `pr-daemon-*`, set `up` / `down` /
  `check` for that repo in the config to the `just pr-demon-*` commands.
- **Trial runs:**
  - issue #96 → PR #97 (site footer, the first trial)
  - issue #99 → PR #100 (`/api/healthz`). It
    exercised resume-after-failure, a comment-triggered revise, and a per-issue-cap
    pause and resume.
- **Measured cost:** a small feature is about 2–3M tokens, around 94% of them
  cache reads.
- **For framejs.app public previews:** its `pr-daemon-up` doesn't use
  `PR_DAEMON_PUBLIC_URL` yet. Its browser code also talks to nhost on
  `local.<svc>.local.nhost.run:<port>`, and those need public routes too.
  That's project work, not pr-daemon work.

## Open items

See PLAN.md. In short:
- a real domain with 80/443 forwarded
- framejs.app public origins
- teardown on a real PR merge, verified end to end
- optional access control for previews
- per-PR spend in the description
