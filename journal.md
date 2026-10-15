# pr-daemon journal

A running log of what was built, decided and learned, newest first. For how the
system works see CLAUDE.md; for the roadmap see PLAN.md.

---

## 2026-10-15: renamed pr-demon → pr-daemon

The name is now the ordinary word for what it is. Everything moved: the package
and the `bin/pr-daemon` launcher, the state directory `~/.pr-daemon/` (and
`pr-daemon.db` / `pr-daemon.log`), the service label, the `X-PR-Daemon` write
header, the `PR_DAEMON_PUBLIC_URL` / `PR_DAEMON_PUBLIC_HOST` stack env vars, the
default project recipes `just pr-daemon-up` / `-down` / `-check`, the Caddy
container `pr-daemon-caddy` and its volume, the screenshot branch
`pr-daemon-assets`, and the PR comment trigger, now `/pr-daemon` (`COMMAND` in
`daemon.ts`).

The old `/demon` trigger is gone, so the footer on the open trial PRs (#97,
#100) asks for a command that no longer works. Comment `/pr-daemon …` on them
instead; new PRs get the right footer.

Names that belong to another repo were left alone: framejs.app's
`pr-demon-setup` branch and its `pr-demon-*` recipes.

**Added a `justfile`** for the repo itself, in the house style: `just` alone
lists every recipe and prints the getting-started checklist and the links,
most-used recipes first (`start`, `dev`, `status`, `logs`). It wraps the CLI
and the dev commands (`check`, `test`, `ci`, `restart`, `logs`, `logs-caddy`,
`config`, `db`, `contract`, `open`).

- `just start` is `pr-daemon serve` in this terminal; `just dev` is the same
  under `node --watch`, so saving a file in `src/` restarts it. The new
  SIGTERM handler makes that clean: Caddy is stopped and relaunched, and the
  status page port is free before the new process binds it.
- There's no `install` recipe: every recipe depends on `_ensure_node_modules`,
  which runs `npm install` when `node_modules` is missing.
- `PR_DAEMON_HOME` and the status-page port are read from the live config, so
  the printed links follow it. They are interpolated, never exported —
  `set export := true` would push `PORT` into the project stacks pr-daemon
  launches, and their justfiles read `PORT` to pick a per-branch dev port.
- Don't confuse it with `examples/justfile`, the contract a *target* project
  implements (`just contract` prints that one).

**A setup page for agents, at `GET /setup`.** `docs/setup.md` is the contract a
project has to meet — what `up` / `down` / `check` must do, the environment
they run in, the paths, how to test it, a checklist. `src/setup.ts` renders it
through the prompts' `{{VAR}}` pass with this machine's real values (the
configured commands, the paths, the preview domain, `max_attempts`), and it's
served as **text/plain** so `curl -s http://localhost:7377/setup` hands an
agent the whole thing and a browser shows it ready to copy. `pr-daemon setup`
prints the same text without the server running; the Config tab links to it.

The status page grew a third tab for it. **Setup** sits between Status and
Config and holds one line to copy:

    Set up this repo for pr-daemon: http://localhost:7377/setup

built from `location.origin`, so it always names the address the page was
actually reached on — change `port` in the config and the pasted line follows.
Paste it into a chat session open on the project and the agent fetches the
contract itself. Routing is a three-way switch on `location.hash`; `#job-<id>`
deep links still land on Status.

**Said plainly that the commands are any shell command.** They always were —
`stack.ts` runs each through `bash -lc` from the worktree root — but every doc
said "recipe" and showed `just`, so it read like a requirement. README, the
config comments, `examples/justfile` and the setup page now lead with
"any shell command" and show docker compose / npm / make / script examples.
The only just-aware code is `missingRecipe()`: `just <recipe>` with no such
recipe counts as "not configured" instead of failing.

**Documented where the checkouts are, in the places you'd look.** `paths()` is
now in the status JSON: the status page shows each stack's worktree under its
branch, each job's detail shows its worktree and `out/` directory, and the
Config tab has a "Where things are" panel. The config file's header lists the
same tree, `just where` prints it with the branches checked out right now, and
the README explains `<org>__<repo>`.

**Made the repos list legible to someone who doesn't write TOML.** `[[repos]]`
is an array-of-tables, and nothing said so. Now `DEFAULT_TOML` has a
REPOSITORIES section that says the double brackets mean "another item in the
list", shows two lines to uncomment, a three-repo example, and where one
block's settings end; the per-repo settings sit under it as a commented
reference. `parseConfig` answers the predictable mistakes by name — `[repos]`
with single brackets, `repos = ["o/r"]`, a block with no `name`, the example
name left in place, the same repo twice — and errors say "[[repos]] block #2"
instead of "repos[1]". `doctor` lists the repos it found, or prints the two
lines to add. The status page's empty state shows the same two-block snippet.
Covered by a unit test over those mistakes.

**Caddy now shuts down with the process** (owner's call). `serve` traps
SIGINT/SIGTERM → `Daemon.shutdown()` → `Proxy.shutdown()`, which stops the
Caddy it manages and blocks `tick()` from starting another; the exit is capped
at 10s so launchd never has to SIGKILL. The trade: a restart (`launchctl
kickstart -k`) means a few seconds with the preview URLs down, where before the
old Caddy kept serving and was adopted. Preview *stacks* still survive a
restart. A SIGKILL or a crash still leaves Caddy running, and it's adopted as
before.

**Swept out the first iteration's leftovers.** The GitHub repo description
still advertised "a coding agent on your own self-hosted runner"; it now
matches `package.json`. Gone from the docs: the stale note about the
`mini2-pr-demon` runner, the launchd aside comparing pr-daemon to it, the
"don't edit a running bash script" gotcha (there are no bash scripts any more),
and "built by the old prototype" on trial #97. What stays on purpose: the
dated journal entries that record the prototype and why it was dropped, the
PLAN.md row explaining why not GitHub Actions, and one line in CLAUDE.md's
decisions saying both were tried and shouldn't be reintroduced.

The runner turned out to be more than a stale note: `mini2-pr-demon` was still
registered and **online** on framejs.app (label `pr-demon`, id 21). It's now
deregistered, so that repo has no self-hosted runners. The runner *service* on
mini2 is still installed and will keep failing to connect — finish it there
with `./svc.sh stop && ./svc.sh uninstall` (and `./config.sh remove`). Also retired
the last of the just-only wording in PLAN.md and the code comments, since any
shell command works.

**Migrating a machine that already ran pr-demon** (nothing to do on a fresh
one — there was no state in this checkout):

```bash
pr-demon uninstall-service        # from a checkout of the old code, or:
launchctl bootout gui/$(id -u)/pr-demon && rm ~/Library/LaunchAgents/pr-demon.plist
mv ~/.pr-demon ~/.pr-daemon
docker rm -f pr-demon-caddy; docker volume rm pr-demon-caddy-data   # if Docker mode
./bin/pr-daemon install-service
```

Then rename the target project's `pr-demon-*` recipes, or point `up` / `down` /
`check` at the old names per repo in the config.

---

## 2026-10-15: public preview URLs, cleanup, handoff docs

**Done**
- Removed the last traces of the GitHub Actions prototype from the code:
  `cleanEnv` now drops only `CI` and the markers of an enclosing Claude Code
  session, and the job table is renamed `RUNNERS` → `JOBS`. In framejs.app,
  removed the unused `pr-demon-url` recipe.
- **Public preview URLs.** With `[preview] domain` set, each branch is served
  at `https://<branch>.<domain>`:
  - pr-daemon supervises **Caddy**, either the binary or the `caddy:2` Docker
    container (`proxy = auto | binary | docker | off`).
  - Routes are rebuilt from the stacks table every 5s and loaded through
    Caddy's admin API when they change.
  - TLS: Let's Encrypt per branch host (`auto`), Caddy's own CA (`internal`,
    for testing), or `off`.
  - `pr-daemon-up` receives `PR_DAEMON_PUBLIC_URL` and `PR_DAEMON_PUBLIC_HOST`.
    A per-repo `proxy_host = public | upstream` controls the Host header the
    app sees.
  - The status page shows the proxy state and public links, and `doctor`
    checks the proxy and DNS.
- Verified with `*.pr-daemon.localhost` on ports 8080/8443:
  - routing works in Docker and binary mode (healthz and the home page of
    #99's stack returned 200 through Caddy)
  - switching modes while running
  - adopting an already-running Caddy after a pr-daemon restart
  - relaunching on port changes
  - stopping when the domain is unset
- Bugs fixed while testing:
  - port changes didn't relaunch Caddy
  - the first Docker start timed out during the image pull
  - Caddy's admin API refused Node's `fetch` (undici sends
    `Sec-Fetch-Mode: cors`), fixed by sending an allowed `Origin`
- Wrote **CLAUDE.md** (goals, owner decisions, code map, gotchas, dogfood
  state) so a future agent session in this repo has the full context.
- Tests: 10 unit tests (amounts, durations, templates, config, budget, host
  labels, public URLs, Caddy config). CI is green.

**Known quirks**
- On non-standard test ports, Caddy's HTTP → HTTPS redirect drops the port.
  With real ports 80/443 this doesn't happen.
- Previews are public to anyone with the URL. There's no access control yet.

---

## 2026-10-14 → 15: rewrite as a single host process

**Decision:** replace the GitHub Actions + self-hosted runner design with
**one Node/TypeScript process** on the host. The owner's choices:
- it acts as their own GitHub user
- only users who are allowed (by default, only the owner) can trigger it by
  adding the label
- the budget is tokens per subscription window in human amounts
- state lives in SQLite
- a web page shows status and edits the TOML config

**Done**
- `pr-daemon serve`, made up of:
  - a GitHub poller: label events (with a check of who added the label) and
    `/demon` comments
  - a SQLite job queue
  - a scheduler with a budget gate
  - an agent supervisor: live token accounting, stall detection, pause and
    resume of Claude sessions, rate-limit handling
  - stack health checks with automatic restarts
  - automatic teardown when the PR or issue closes
- Status page on `localhost:7377` with Cancel, Resume, Retry, Pause,
  Restart/Tear down for stacks, an event log, and a raw TOML config editor
  that validates before saving.
- `install-service`: a launchd agent (or systemd user unit). `claude` works
  headless under launchd with HOME and PATH set, so no OAuth token is needed.
- **Dogfood: framejs.app issue #99 → PR #100** (`/api/healthz`). It
  exercised:
  - build → check → fix → PR → fresh review (`VERDICT: ok`)
  - resuming after a failed push (the same Claude session continued)
  - a `/demon` revise that was paused mid-run by the per-issue cap, then
    resumed in the same session after the cap was raised
  - preview stacks surviving a pr-daemon restart
- Teardown verified manually on #96.

**Learned**
- stream-json repeats usage once per content block, so dedupe by message id.
- Pushes that touch `.github/workflows` are refused because the gh login has
  no `workflow` scope. That's a good guard, and pr-daemon now explains it when
  it happens.
- `gh issue edit --remove-label` fails the whole edit if any one label
  doesn't exist, so status labels are set through the REST API instead.
- Node crashes on unhandled promise rejections, so error handlers that call
  GitHub must never throw.

---

## 2026-10-13 → 14: first prototype (GitHub Actions + self-hosted runner), since removed

**Built** (bash, now deleted):
- a composite action plus an example workflow
- a dedicated runner with only the `pr-demon` label
- a job-started hook that refused any workflow except `pr-demon.yml` on `main`
- prompts for build, fix, review and revise

**Dogfood: framejs.app issue #96 → PR #97** (site footer):
- branch, stack, build and tests, then a PR with 4 screenshots
- an independent review that caught a committed tool cache
- an automatic revise that fixed it

The run cost about 2.8M tokens, around 94% of them cache reads.

**Why it was dropped**
- Too much setup: a runner, a hook, a workflow per repo, repo settings, and a
  Claude token, because the runner service couldn't use the keychain login.
- `GITHUB_TOKEN` quirks: its pushes don't trigger CI, and the PRs it opens
  don't trigger other workflows.
- No live control over token use.

---

## Next steps

**Needs the owner**
1. **Real preview domain:**
   - set `[preview] domain` (and optionally `email`) in the Config tab
   - point a wildcard DNS record `*.<domain>` at this machine
   - forward ports 80 and 443 to it
   - run `pr-daemon doctor` to confirm
2. **Rename framejs.app's recipes to `pr-daemon-*`** on its `pr-demon-setup`
   branch (they still use the old name), then merge that branch → `main` and
   delete `base = "pr-demon-setup"` from the config.
3. **Close or merge the trial PRs #97 and #100.** Closing one also verifies
   automatic teardown on PR close, end to end.
4. **Decide when to make `metapages/pr-daemon` public.** It's written to be
   safe for that.

**Engineering**
- framejs.app public previews (good first `agent` issue):
  - its `pr-daemon-up` should use `PR_DAEMON_PUBLIC_URL` for app origins
  - its browser code calls nhost on `local.<svc>.local.nhost.run:<port>`,
    which also needs public routes
- Optional access control on previews (basic auth or a shared secret).
- A wildcard certificate through a DNS challenge, instead of one Let's Encrypt
  certificate per branch.
- Show the spend per PR in its description, and per-repo budgets.
- A form view of the config next to the raw TOML.
- Several machines coordinating through GitHub labels.
