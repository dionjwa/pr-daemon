# pr-demon: context for agents working on this repo

Read this first (then journal.md for the history and next steps). It records the goals, the owner's decisions, how the code fits
together, and what we learned the hard way. User-facing docs are in README.md
(keep that one simple and step-by-step); the roadmap is in PLAN.md.

## What it is

Label a GitHub issue `agent`, get a pull request. One long-running process on
the owner's machine (`pr-demon serve`):

1. polls GitHub for issues that just got the `agent` label, checking **who** added it
2. creates a worktree on a branch `<issue>-<short-kebab-summary>`
3. starts that branch's full stack (`just pr-demon-up`, which prints the local URL)
4. runs headless Claude Code to build the feature and tests, then re-runs the
   project's check (`just pr-demon-check`) and resumes the same session to fix
   failures, up to N rounds
5. pushes and opens a PR with a description, screenshots and a preview link
6. runs a **fresh** Claude session to review the PR (it sees only the PR), with
   one automatic revise round if the verdict is `changes`
7. `/demon <feedback>` comments on the PR trigger further revisions
8. when the PR or issue closes: `just pr-demon-down`, remove the worktree, clear labels
9. with `[preview] domain` set: runs Caddy so each branch is at
   `https://<branch>.<domain>`

All agent work happens within a token budget (rolling window plus per-issue cap).
A human always merges.

## The owner's decisions (don't change these without asking)

- **One host process**, not GitHub Actions. A self-hosted Actions runner
  prototype existed and was **deliberately removed**: the runner plus job hook
  plus per-repo workflow plus `GITHUB_TOKEN` quirks were too much setup and
  gave no control over token use.
- **Node + TypeScript**, run directly (Node ≥ 23.6 strips types; no build
  step). Only syntax that can be stripped: no enums, namespaces or parameter
  properties, and imports use `.ts` extensions.
- **SQLite via built-in `node:sqlite`** for jobs, the token ledger, stacks,
  events and kv. No native modules.
- **Config is one TOML file** (`~/.pr-demon/config.toml`). The status page
  edits the **raw text**, so comments survive. It's validated before it's
  written, and changes apply live.
- **Status page** on `127.0.0.1:7377` only: vanilla HTML in `src/ui.html`, no
  framework, no build, **no `alert`/`confirm` dialogs** (click twice to
  confirm).
- **Acts as the owner's own GitHub user** through `gh`. No bot account and no
  GitHub App. Consequences: you can't *approve* your own PR, so the reviewer
  posts a COMMENT review and the owner merges. Pushes trigger the project's
  normal CI.
- **Only allowed users trigger work**: the actor of the `labeled` event and the
  author of `/demon` comments must be in `allowed_users` (default: the gh user).
- **Trigger label is `agent`.** Status labels are `agent:working`,
  `agent:in-review`, `agent:paused` and `agent:failed`.
- **Budget:** optional tokens per rolling window (default `5h`, one Claude
  subscription window), in human amounts (`"40M"`), plus an optional
  `per_issue` cap. Hitting the window limit pauses and auto-resumes. Hitting
  the per-issue cap pauses until a human presses Resume.
- **Portable:** a project only adds `pr-demon-up` (start in the background,
  print the URL last) and `pr-demon-down`. `pr-demon-check` is optional. Every
  command can be overridden per repo.
- **Public previews:** the owner routes `*.<domain>` (DNS plus ports 80/443) to
  the machine. pr-demon owns Caddy (binary or Docker) and the routing.
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
| `web.ts` / `ui.html` | The localhost API (Host check; writes need `X-PR-Demon: 1`) and the page |
| `util.ts` | Amounts/durations, `run`/`sh`/`must`, `cleanEnv` |

**Job lifecycle:** `queued → running → done | failed | cancelled | paused`, and
`ignored` for disallowed triggers. Each job has a unique `trigger_key`
(label event id, comment id, …), so a GitHub event triggers exactly once. A
paused or crashed job keeps its `session_id`, and resuming continues that
Claude session. On startup, `running` jobs are re-queued.

**Runtime files:** everything lives in `~/.pr-demon/`: `config.toml`,
`pr-demon.db`, `pr-demon.log`, `repos/` (cached clones), `worktrees/`, `out/`
(prompts, agent `*.jsonl` logs, PR text, screenshots), `assets/` (the
screenshot branch clone), `caddy/`.

## Develop and test

```bash
npm install
npm run check                 # tsc --noEmit
npm test                      # node --test src/*.test.ts (pure logic: amounts, config, budget, Caddy config)
./bin/pr-demon doctor         # tools, logins, config, preview proxy
./bin/pr-demon run build owner/repo 42     # one job inline, no daemon needed
launchctl kickstart -k gui/$(id -u)/pr-demon   # restart the installed service after code changes
tail -f ~/.pr-demon/pr-demon.log
```

- The service runs the code from this checkout, so restart it to pick up
  changes. Jobs that were running are re-queued and resume their Claude
  sessions.
- **Testing previews without a real domain:** `[preview] domain =
  "pr-demon.localhost"`, `tls = "internal"`, `http_port = 8080`,
  `https_port = 8443`, then `curl -sk https://<branch>.pr-demon.localhost:8443/`.
- **Driving the API from zsh:** zsh doesn't word-split unquoted variables, so
  write headers out: `-H 'x-pr-demon: 1'`.
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
  stacks and Caddy `detached` means they survive pr-demon restarting. (The
  removed Actions runner, by contrast, could *not* use the keychain login.)
- **Caddy admin API vs Node `fetch`:** undici sends `Sec-Fetch-Mode: cors`, and
  Caddy then refuses requests without an allowed `Origin`. `proxy.ts` sends
  `Origin: http://<admin>` and lists it in `admin.origins`.
- **Caddy ports are fixed at launch** (Docker publishes them). Changing
  ports, mode, admin address or TLS mode means stop plus relaunch: the
  `proxy:launched` kv key. The first Docker start can take a minute
  (image pull).
- **Unhandled promise rejections crash Node.** Handlers that call GitHub use
  `.catch(() => {})`, and `serve` logs any stray rejection instead of dying.
- **Don't edit a running bash script.** That was a problem in the old bash
  prototype; it's why everything is now in one Node process.
- **Agents read the target project's CLAUDE.md and skills** from the worktree.
  Project knowledge belongs there, not in pr-demon's prompts.

## Dogfood setup (the owner's machine)

- **Target repo:** `metapages/framejs.app` (Deno Fresh worker plus nhost
  backend; local checkout `../framejs-nhost3`). Its `pr-demon-*` recipes live
  on branch **`pr-demon-setup`** (not yet merged to `main`), so the owner's
  config has `base = "pr-demon-setup"` for that repo. Remove that line after
  the merge.
- **Trial runs:**
  - issue #96 → PR #97 (footer, built by the old prototype)
  - issue #99 → PR #100 (`/api/healthz`, built by this version). It
    exercised resume-after-failure, a `/demon` revise, and a per-issue-cap
    pause and resume.
- **Measured cost:** a small feature is about 2–3M tokens, around 94% of them
  cache reads.
- **The old Actions runner** `mini2-pr-demon` (`~/actions-runner-pr-demon`)
  may still be registered and idle. It's unused, and safe to remove with the
  owner's OK.
- **For framejs.app public previews:** its `pr-demon-up` doesn't use
  `PR_DEMON_PUBLIC_URL` yet. Its browser code also talks to nhost on
  `local.<svc>.local.nhost.run:<port>`, and those need public routes too.
  That's project work, not pr-demon work.

## Open items

See PLAN.md. In short:
- a real domain with 80/443 forwarded
- framejs.app public origins
- teardown on a real PR merge, verified end to end
- optional access control for previews
- per-PR spend in the description
