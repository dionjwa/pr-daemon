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
7. watches **the repo's own CI** on the PR (check runs and commit statuses) and,
   when it goes red, runs an agent to fix it: once per failing head commit, up
   to `checks.max_rounds` per PR
8. watches whether the PR still **merges into its base** and, when it
   conflicts, merges the base in (never a rebase or force-push) with an agent
   resolving the conflicts; risky or uncertain ones go to a human
9. `/pr-daemon <feedback>` comments on the PR trigger further revisions
10. when the PR closes (or the issue, before there's a PR), or the `agent` label
   is removed: `just pr-daemon-down`, remove the worktree, clear labels, and
   delete the branch on GitHub. Removing the label also cancels running jobs
   for the issue and closes its open PR. The page's Tear down button keeps the branch.
11. with `[preview] domain` set: runs Caddy so each branch is at
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
  So must everyone who **wrote** the issue: author, body editors and title
  renamers (`gh.provenance()`, GraphQL), checked at label time and again at
  every build start. Revise prompts only get PR comments from trusted authors
  (`gh.trustedDiscussion()`: allowed users plus the gh user). Agents are
  told not to fetch comments themselves; don't reintroduce `--comments`.
  The status page, `status` and `doctor` all name the gh user it acts as and
  who is allowed (`status().github`); keep that visible. The README's Safety
  section is the contract: recommended for private repos, because the issue
  body and PR comments are agent input regardless of who added the label.
- **The repo's own CI is the outer check** (`[checks]`). pr-daemon pushes as
  the owner, so normal CI runs on every push; it reads the verdict per PR
  (`gh.checks()`), shows it on the status page, and queues a `ci` job when red.
  The trigger key is the **head sha**, so one failing commit gets exactly one
  agent, and `max_rounds` (default 2) caps the attempts per PR — a fix that
  doesn't fix it can't loop. `fix = false` (or `max_rounds = 0`) watches
  without acting. The local `check` command stays the *inner* gate, before any
  PR opens; CI is the one that knows about other platforms, secrets and matrices.
- **Conflicts with the base are fixed by merging, never rebasing** (`[merge]`).
  No force-push, review comments stay on their commits. Automate the routine
  and hand the risky to a human: `merge.assessConflicts()` decides what an
  agent may try (binary, workflow files, too many files, `human_paths` and the
  round cap go to a person). pr-daemon, not the agent, verifies and commits
  the merge. Nothing is pushed unless the check passes. A pushed resolution
  the agent wasn't sure of is flagged **needs your review** (PR comment
  `> [!WARNING]`, status page, desktop notification). A hand-over leaves the
  PR untouched and keeps the attempt on a local branch. One trigger per head
  sha. Rounds are agent runs (`countAgentRuns`: jobs with tokens > 0), so
  clean merges are free.
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
| `cli.ts` | Commands: `serve`, `status`, `stop`, `doctor`, `setup`, `run <kind> <repo> <n>`, `install-service` / `uninstall-service` (launchd plist / systemd user unit) |
| `daemon.ts` | The process: GitHub poll loop, scheduler (priority, concurrency, per-branch locks, budget gate), job launch and error→state mapping, page actions, `status()` JSON |
| `pipeline.ts` | The jobs (`JOBS`): `build`, `review`, `revise`, `ci`, `merge`, `teardown`, `restart`. `agentStep()` runs Claude under the budget. Prompt templates are rendered from `prompts/*.md` with a single-pass `{{VAR}}` |
| `agent.ts` | Spawns `claude -p --output-format stream-json --verbose`, with `--session-id` for new sessions and `--resume` to continue. Live usage deltas, tool-activity lines, stall timer, kill switch, rate-limit detection |
| `transcript.ts` | Parses an agent's `*.jsonl` log into what it said, each tool call and its result, for `GET /api/jobs/<id>/transcript?from=N` (the page polls for new entries). `agentLog(job)` in `pipeline.ts` is the one place that knows each job's log path |
| `merge.ts` | The pure merge decisions: `assessConflicts()` (agent or human), `hasConflictMarkers()`, `parseMergeReport()` (the agent's `CONFIDENCE` / `NEEDS_HUMAN` trailer), `reviewReasons()` (what makes a pushed merge "needs your review"). The git side (`startMerge`, `conflicts`, `abortMerge`, `commitMerge`) is in `git.ts` |
| `budget.ts` | Rolling-window sum, per-issue sum, `gate()`, and when the window frees up |
| `proxy.ts` | Caddy supervisor. `caddyConfig()` is pure (unit-tested): routes are rebuilt from the stacks table every 5s and loaded via the admin API when the hash changes |
| `db.ts` | Schema plus `Store` (jobs, usage, stacks, events, kv) |
| `gh.ts` / `git.ts` / `stack.ts` | Wrappers for `gh` (as the user), the cached clone plus worktrees plus the screenshot branch, and the project's up/down/check commands. `gh.summarizeChecks()` reduces check runs + commit statuses to one verdict; `stack.previewHealth()` turns the two health probes into up/degraded/down (both pure, unit-tested) |
| `config.ts` | `DEFAULT_TOML` (the documented template), `parseConfig()` with readable errors, atomic save |
| `web.ts` / `ui.html` | The localhost API (Host check; writes need `X-PR-Daemon: 1`) and the page |
| `setup.ts` / `docs/setup.md` | `paths()` (the runtime directories) and `setupDoc()`: the project contract with this machine's real paths and commands filled in, served as plain text at `GET /setup` and printed by `pr-daemon setup` |
| `util.ts` | Amounts/durations, `run`/`sh`/`must`, `cleanEnv` |

The repo's own `justfile` wraps the CLI plus the dev commands; `examples/justfile` is the contract a target project implements.

**Job lifecycle:** `queued → running → done | failed | cancelled | paused`, and
`ignored` for a trigger pr-daemon decided not to act on (a disallowed user, or
a failing check it won't fix because of `fix`/`max_rounds`) — the row records
the decision so it isn't taken twice. Each job has a unique `trigger_key`
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
just stop                     # shut it down, however it was started
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
- **`gh run view --log-failed` can print nothing and still exit 0.** Two
  reasons, both real here: gh **< 2.73** (this laptop had 2.60) returns an
  empty log for runs it can't parse, and GitHub simply has no logs for some
  runs (expired, or a self-hosted runner that uploaded none). So
  `gh.failureLogs()` falls back to the failed **job and step names** from
  `actions/runs/<id>/jobs`, which at least tells the agent where to look. The
  check-run `output.title`/`summary` is already in each failing entry's note.
- **A green health dot meant "the server answered", not "the preview works".**
  The old check hit the stack's own address and accepted anything under 500, so
  a branch whose public URL 404'd showed green (found in the wild:
  `115-fix-editor-loading` answered 200 locally and 404 publicly for days).
  Health is now two probes compared by `stack.previewHealth()`: **down** (the
  stack doesn't answer — a restart may help, and `auto_restart` queues one),
  **degraded** (the stack answers, the public URL doesn't give the app — a
  restart cannot help: it's Caddy, DNS or the Host) and **up**. Identical codes
  count as up, so an app whose `/` is a 404 isn't reported as broken and a
  proxy faithfully relaying that 404 isn't either. Only `up` counts as "ready",
  so the notification doesn't fire for a preview nobody can open.
- **A public 404 with a healthy stack is almost always the Host.** Caddy sends
  the public host upstream unless `proxy_host = "upstream"`, and a local gateway
  that routes on Host (nhost, Traefik, a Vite dev server with `allowedHosts`)
  answers 404. The row says so, and names the repo to set it on.
- **gh must be ≥ 2.73.** Older `gh pr edit` asks for the Projects (classic)
  `projectCards` field, which GitHub has switched off, so it fails. `doctor`
  checks the version. Upgrade gh; don't work around it in code.
- **`gh issue edit --remove-label` fails the whole command** if one label
  doesn't exist. `setStatus()` uses the REST API and only removes labels the
  issue has.
- **launchd:** `claude` works headless when HOME and PATH are set (the plist
  does this; no OAuth token needed). `AbandonProcessGroup` plus starting
  stacks `detached` means preview stacks survive pr-daemon restarting.
- **Shutdown stops the agents, but not the jobs.** The service lets children outlive pr-daemon (`AbandonProcessGroup` / `KillMode=process`, for the preview stacks), so an agent left alone would keep working beside the resumed copy of its own session. `doShutdown()` kills each running agent (Claude takes its tool processes with it) and waits up to 12s. `launch()` leaves those jobs `running`, and `recoverRunning()` re-queues them on the next start to `--resume`. A SIGKILLed or crashed pr-daemon can't do that, and its agents **keep working** with nobody reading their output (tested: one finished its whole task), so `start()` first runs `stopOrphans()`: any `claude -p` whose `--session-id`/`--resume` is a `running` job's session gets SIGTERM (SIGKILL after 10s) before the job resumes. Their in-flight work is lost and redone. Taking them over instead would need agents writing to a file rather than a pipe.
- **`stop` can't rely on the API.** `pr-daemon stop` POSTs `/api/shutdown`,
  but anything older than that endpoint (or wedged) won't answer — the
  pre-rename build 403s it, since its write check wants `X-PR-Demon`. So
  `stop` falls back to `lsof -t` on the status port and SIGTERMs that pid,
  **only** when its command line matches `(cli.ts|bin/pr-daemon)\s+serve`.
  Matching a pr-daemon *path* isn't enough: an editor or shell sitting in the
  checkout would match, and a test caught exactly that.
- **Caddy is tied to the process:** `serve` traps SIGINT/SIGTERM and calls
  `Daemon.shutdown()` → `Proxy.shutdown()`, which stops the Caddy it manages
  (admin `/stop`, or `docker rm -f`) and sets a `stopped` flag so `tick()`
  can't start another. So a restart costs a few seconds of preview downtime.
  Caddy still runs `detached`, so a signal can't kill it mid-request; if
  pr-daemon is SIGKILLed, the surviving Caddy is adopted on the next start.
- **Watching config.toml means watching its DIRECTORY.** `saveConfigText`
  writes `config.toml.tmp` and renames it over the real file, and a watch on a
  path follows the inode it was opened on — a file watch would survive exactly
  one save and then go silently deaf. `Daemon.watchConfig()` watches the
  directory and filters on the basename, debounces 250ms (a save is several
  events, and reading too early catches a half-written file), ignores text
  identical to what it last wrote (so the Config page's own save doesn't
  announce twice), and on a parse error logs once and keeps the running config.
  `port` and `prevent_sleep` are fixed at startup, so `apply()` says so instead
  of pretending they changed.
- **Caddy admin API vs Node `fetch`:** undici sends `Sec-Fetch-Mode: cors`, and
  Caddy then refuses requests without an allowed `Origin`. `proxy.ts` sends
  `Origin: http://<admin>` and lists it in `admin.origins`.
- **Caddy rewrites Host for https upstreams.** With a TLS transport it sends
  the dial address (`127.0.0.1:<port>`) as Host, not the public one, so a
  Host-routing gateway (Traefik) 404s. `proxyTo()` sets
  `{http.request.hostport}` explicitly unless `proxy_host = "upstream"`.
- **Caddy ports are fixed at launch** (Docker publishes them). Changing
  ports, mode, admin address or TLS mode means stop plus relaunch: the
  `proxy:launched` kv key. The first Docker start can take a minute
  (image pull).
- **Unhandled promise rejections crash Node.** Handlers that call GitHub use
  `.catch(() => {})`, and `serve` logs any stray rejection instead of dying.
- **Docker's address pool runs out at about 31 bridge networks.** Each preview
  stack takes one or two, and a teardown that skips `down` (the worktree is
  already gone, or the project's `down` command doesn't exist) used to leak
  them until every later `up` died with "all predefined address pools have
  been fully subnetted". `stack.up()` now diffs `docker network ls` around the
  command and records what it created in `stacks.networks`; `teardown` removes
  exactly those, and only while nothing is attached. Networks pr-daemon didn't
  create are never touched — `docker network prune` would take out the
  machine's other stacks. `doctor` counts bridge networks and the idle ones,
  and `poolHint()` adds the explanation to the stack error when Docker says
  the pool is full.
- **A stack is wired for one origin.** With a domain set, Chrome's Local
  Network Access blocks the public page from calling loopback, so a page at
  `https://<branch>.<domain>` calling `local.auth.local.nhost.run` (127.0.0.1)
  fails as "CORS ... `loopback` address space". So in public mode the public
  URL is the only one used (agent prompts via `stackWhere()`, PR body, status
  page). Every backend the browser calls gets `https://<branch>--<service>.<domain>`,
  declared by `up` printing `PR_DAEMON_ROUTE <service> <local-url>` (stored in
  `stacks.routes`). Those routes always send the upstream's local Host, because
  gateways like nhost's route on it. `hostLabel()` caps the branch at 48
  characters so `--<service>` (at most 12) fits in a 63-character label.
- **Wildcard certificates (`[preview] dns = "cloudflare"`):** Let's Encrypt
  only issues wildcards through DNS-01, so Caddy needs the
  `caddy-dns/cloudflare` module (`caddy add-package`, which a `brew upgrade`
  undoes; Docker mode builds `pr-daemon-caddy-cloudflare`) and a token from
  `$CLOUDFLARE_API_TOKEN` or `~/.pr-daemon/cloudflare-token`. caddy.json only
  holds `{env.CLOUDFLARE_API_TOKEN}`, and `cleanEnv` drops the variable so
  agents never get it. Caddy 2.11 rejects `automatic_https.prefer_wildcard`:
  since 2.10 a managed wildcard covers its subdomains by default. The module
  refuses tokens that don't look real, so validate configs with a
  40-character fake.
- **Check the proxy on its own:** Caddy answers `https://pr-daemon.<domain>`
  itself, and `doctor` fetches it. When debugging, also look for
  `rateLimited` in `~/.pr-daemon/caddy/caddy.log`: 5 failed certificate
  attempts on a host (e.g. while DNS was wrong) lock that host out for an hour,
  and `just dev` restarting Caddy on every edit burns through attempts fast.
- **The config editor colours TOML with no library.** A highlighted `<pre>`
  sits under a transparent `<textarea>` (same font, same padding, scroll synced
  on `input`/`scroll`): the page stays one file, works offline, and keeps the
  textarea's own undo and caret. A CDN editor would break both. The Config tab
  has a second inner tab serving `DEFAULT_TOML` from `GET /api/config/default`:
  every option with its default, read-only, so the template stays discoverable
  after the file has been edited.
- **Headless Claude doesn't log its thinking.** `thinking` blocks in stream-json have empty text (`showThinkingSummaries` doesn't change it), so the transcript shows the agent's narration, tool calls and results. Claude doesn't log the `-p` prompt either: `agent.ts` writes a `{"type":"pr-daemon","subtype":"start"}` line with it at the start of each run.
- **GitHub's `mergeable` is lazy.** It's `null` until GitHub computes it after
  a push to either side, so `gh.mergeability()` calls that `unknown` and the
  next poll asks again. Right after pr-daemon pushes a merge, GitHub can still
  say "dirty" for a moment; the new head gets a new trigger, and that job finds
  "already up to date" and does nothing. The local `git merge` is the truth,
  not GitHub's flag.
- **A merge commit can need the `workflow` scope** (expected from GitHub's
  rules, not yet seen here) even though the agent never touched a workflow:
  if the base changed `.github/workflows/`, the merge brings that change in,
  and GitHub refuses the push. For a clean merge,
  `viaGitHub()` asks GitHub to do it (`PUT pulls/<n>/update-branch` with
  `expected_head_sha`). A conflicted one is handed to the human before the
  agent spends anything (`gh.hasWorkflowScope()`).
- **Binary conflicts leave no markers,** so a marker check alone would pass
  them. `git.conflicts()` marks them (`diff --numstat :2:f :3:f` prints
  `-\t-`), and they always go to a human. `=======` alone isn't counted as a
  marker: it's a markdown heading underline.
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
  backend). Its recipes live on branch **`pr-demon-setup`** (not yet merged
  to `main`), so the owner's config has
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
- **For framejs.app public previews:** pr-daemon's side is done
  (`PR_DAEMON_ROUTE`). The project still has to do its part: `pr-daemon-up`
  must print `PR_DAEMON_ROUTE auth|graphql|storage|functions
  https://local.<svc>.local.nhost.run:<NHOST_HTTP_PORT>`, give the browser
  nhost client explicit public service URLs instead of `subdomain=local`, and
  set nhost auth's client URL and allowed redirects to `PR_DAEMON_PUBLIC_URL`.
  The DNS record is `*.home` CNAME `home.<domain>` (DNS only): a
  `home.` target with a trailing dot was the first outage.

## Dogfood findings worth keeping

- **metapages/framejs.io needs `proxy_host = "upstream"`.** Its stack is served
  by a gateway that routes on Host, so `https://<branch>.home.dionjw.dev`
  returned 404 while the stack answered 200 locally. The status page now shows
  that as **degraded** and names the fix on the row.

## Open items

See PLAN.md. In short:
- a real domain with 80/443 forwarded
- framejs.app public origins
- teardown on a real PR merge, verified end to end
- optional access control for previews
- per-PR spend in the description
