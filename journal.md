# pr-daemon journal

A running log of what was built, decided and learned, newest first. For how the
system works see CLAUDE.md; for the roadmap see PLAN.md.

---

## 2026-10-25: keeping PRs mergeable (`[merge]`)

**"Can it merge main in and deal with the conflicts?"** Before this, a PR that
stopped merging just sat there: GitHub showed "This branch has conflicts", and
CI often didn't run on it at all.

Now the poll reads GitHub's `mergeable` / `mergeable_state` from the PR read it
already makes (free), and shows it in a **Merge** column. When there are
conflicts (or, with `merge.behind`, the base only moved on), it queues a `merge`
job, once per head sha. The job:

- merges the base in (`--no-ff`, diff3 markers). It never rebases, so there's
  no force-push and review comments stay put.
- **clean:** commits, restarts the stack, runs the check and pushes. No agent.
- **conflicts:** `assessConflicts()` first. Binary files, workflow files, more
  than `max_files`, `human_paths`, an exhausted `max_rounds`, or base workflow
  changes the gh login can't push all go straight to the human, before any
  tokens are spent. Otherwise the builder's session gets the conflicts and the
  base's commits touching those files, resolves them, and writes
  `merge-report.md` ending in `CONFIDENCE` / `NEEDS_HUMAN`.
- pr-daemon verifies and commits the merge itself (`verifyResolution`): the
  same merge, the right parents, no markers left. Then the check must pass,
  with the usual fix rounds. A clean merge that breaks the check gets them too.
- if anything fails, nothing is pushed. The attempt is kept as a local branch
  `<branch>-merge-attempt-<job>`, the worktree is reset to the PR head, the
  issue gets `agent:failed`, and a comment says why and how to do it by hand.
- after a push, `reviewReasons()` decides whether the comment opens with
  **Needs your review before merging**: low or missing confidence, agent
  flags, a delete-vs-modify conflict, files only the agent touched, or no local
  check. If it does, there's also a desktop notification and a "needs your
  review" badge.

Design choices: rounds are agent runs (`countAgentRuns`, jobs with tokens > 0),
so clean merges never use up the cap. `merge` sits above `ci` in the queue,
since a conflicting PR's CI is moot.

**Not verified yet:** a real conflicting PR end to end, and whether GitHub's
`update-branch` really gets round the missing `workflow` scope for a clean
merge (the fallback in `viaGitHub()`). The git mechanics are tested against a
real local origin in `merge.test.ts`.

---

## 2026-10-18: nobody was watching CI, and a green dot was lying

Two gaps, found by asking two questions.

**"Do we monitor the tests after we push?"** No. The only gate was the local
`check` command, run in the worktree before the PR opened, and again after a
revise (which pushed regardless and only mentioned the result in a comment).
Once the PR existed, nothing read GitHub again except to notice it had closed.
A branch that passed locally and failed in CI — a different platform, a secret,
a matrix job, a lint step not in `pr-daemon-check` — sat red with `agent:in-review`
on the issue and no one told. The reviewer agent didn't know either.

Now `[checks]`. Each poll, for every stack whose PR is open, pr-daemon reads
GitHub's verdict for the PR's head commit (`gh.checks()`: check runs *and* the
older commit statuses, since a repo may use either) and stores it on the stack
row, so the page shows passing / running / failing per preview. When it's
failing it queues a `ci` job: the builder's own Claude session where we still
have it, given the failing check names, their notes and the tail of the failed
job logs, told to fix the cause, never to weaken a test, and never to touch
`.github/workflows/` (pr-daemon's push would be rejected for want of the
`workflow` scope). It commits, pr-daemon pushes, and the push makes CI run
again.

The loop-safety is the part worth remembering: **the trigger key is the head
sha**. One failing commit gets exactly one agent, however many times it's
re-run or re-polled; the fix produces a new commit, so a new failure is a new
decision; and `max_rounds` (default 2) caps the attempts per PR, after which it
comments on the PR and stops. `fix = false` or `max_rounds = 0` watches without
acting, and records that it decided not to (an `ignored` job row), so the
decision isn't retaken every minute. A `ci` job outranks a new `build` in the
queue: work already in a human's hands comes first.

Verified against the real `metapages/framejs.io` PR #116 — which was, as it
happens, red and unattended: pr-daemon read `1 failing: Test` at `01db38f3`,
queued one fix, and queued nothing more on the next poll.

**"Why is this stack green when the preview 404s?"** Because
`stack.healthy()` asked the wrong address the wrong question: it probed the
stack's own URL and accepted any status under 500. `115-fix-editor-loading`
answered 200 at `https://framejs-io.localhost:32974` and 404 at
`https://115-fix-editor-loading.home.dionjw.dev`, and the page said it was fine.
The 404 was Caddy relaying a 404 from the upstream, not Caddy failing to route:
the stack sits behind a gateway that routes on Host, and Caddy sends the public
host unless `proxy_host = "upstream"`. The documented gotcha, undetected
because nothing looked.

Health is now two probes and a comparison (`previewHealth`, pure and tested):

- **down** — the stack's own address doesn't answer (or 5xx). A restart may
  help; `auto_restart` queues one, as before.
- **degraded** — the stack answers, the public URL doesn't give the app. A
  restart *cannot* help, so it doesn't happen; the row names the likely fix,
  including which repo to set `proxy_host = "upstream"` on.
- **up** — the address people actually open answers. Identical codes count as
  up, so an app whose `/` is a 404 doesn't read as broken, and neither does a
  proxy faithfully relaying it.

"Ready" (the desktop and browser notifications) now means *up*, not "the
process started". `doctor` lists each stack's state too, and `pr-daemon status`
prints it.

**The page.** Preview stacks moved to the top, where the thing you came to
click lives. Each row expands to every address the stack has — public URL and
its status code, the local upstream behind it, every service with its upstream,
the worktree, the commit its checks are about, its Docker networks — and a
footer says plainly what does and doesn't stop a stack, because "do these get
shut down after a while?" is the question a stale preview makes you ask (they
don't; only a closed PR or issue, a removed label, or Tear down).

**Config colouring, without a dependency.** A highlighted `<pre>` under a
transparent `<textarea>`, same font, same padding, scroll synced: TOML in
colour while keeping the textarea's own undo, caret and selection, in one file
that still works offline. A second tab in Config serves `DEFAULT_TOML` from
`GET /api/config/default` — every setting, its default and what it does — so
the documented template stays reachable after the file has been edited past it.

**Learned along the way:** `gh run view --log-failed` can print nothing and
exit 0 — on gh < 2.73 (this laptop still had 2.60) and whenever GitHub has no
logs for the run (expired, or a self-hosted runner that uploads none). When
that happens, `failureLogs()` falls back to the failed job and step names from
`actions/runs/<id>/jobs`, which at least points the agent at the right step.

---

## 2026-10-15: there was no way to stop it

You could start pr-daemon four ways and stop it none: Ctrl-C if it had a
terminal, `uninstall-service` if it didn't, and nothing at all for a process
started in the background. Now:

- **`pr-daemon stop`** (`just stop`). A service is stopped first — launchd's
  `KeepAlive` would restart the process the moment it exited — then whatever
  still answers on the status port is asked to quit, and it waits for the port
  to go quiet before reporting. Run twice, it says nothing is running.
- **A "Shut down" button** in the status page header, two clicks to confirm
  (no dialogs here, as ever).
- Both go through `POST /api/shutdown` → `Daemon.requestShutdown()`, which
  answers the request first and then exits exactly like SIGTERM does: Caddy
  stops with it, running jobs are re-queued and resume their Claude session
  next start. Preview stacks keep running on their local ports.

One wrinkle worth knowing: under `just dev` the `node --watch` parent survives
`just stop` and will start a new daemon on the next edit to `src/`. Ctrl-C the
watcher, or kill that pid. The `dev` recipe says so now.

**Then `just stop` met something it couldn't stop.** A process had been
holding 7377 since 07:47 — the *old* build, run from the pre-rename checkout
`…/pr-demon/src/cli.ts` against `~/.pr-demon/`, orphaned to launchd when its
terminal closed. It has no `/api/shutdown` (that endpoint is hours younger)
and its write check still wants `X-PR-Demon`, so the polite request came back
`403` and `stop` could only report that it was still answering. Asking nicely
is not a plan when the thing on the port predates the question.

`stop` now falls back to the process holding the port: `lsof -t`, then
`SIGTERM`, but only when its command line matches our entrypoint
(`cli.ts serve` or `bin/pr-daemon … serve`). Two bugs fell out of testing
that, both fixed: the first gate matched any command mentioning a pr-daemon
path, so it killed an unrelated process whose script merely lived in this
directory; and with nothing running at all, `stop` printed "Stopped" because a
failed status fetch read as "it exited". Four cases are covered now — clean
shutdown, a build that won't answer, a stranger on the port (reported, left
alone), and nothing running.

---

## 2026-10-15: preview stacks were leaking docker networks

Feedback from setting up a fourth repo: the first `up` failed with **"all
predefined address pools have been fully subnetted"**. The machine had 32
bridge networks, 21 attached to nothing, 13 of them
`framejs-nhost-frontend-<branch>_default` from branches that no longer exist.
Removing the 13 empty ones fixed it. Docker's default pool fits about 31
bridge networks and each preview takes one or two, so with four repos
registered this was a standing hazard, not a one-off.

Nothing pruned them, because several routes skip `down`: teardown when the
worktree is already gone, and `down` itself when the project's command names a
recipe that doesn't exist (which is exactly what the `pr-demon-*` →
`pr-daemon-*` rename caused for a while).

`stack.up()` now diffs `docker network ls` around the command and returns the
ids that appeared; they accumulate in a new `stacks.networks` column across
every `up` of that branch. `teardown` removes exactly those, and only the ones
with no containers attached — `docker network rm` refuses in-use networks
anyway, and a blanket `docker network prune` would take out the machine's
other stacks (caddy, jupyter, marimo, instantreview), which is why it isn't
used. Verified end to end: an `up` that creates two networks records both,
teardown removes the idle one, and the one with a container attached is left
alone.

Two more hands on the problem: `doctor` reports `docker bridge networks: N, M
with nothing attached` and names the idle ones once the count passes 24, and
`poolHint()` appends an explanation to the stack error when Docker says the
pool is full (it matches both phrasings Docker uses — unit-tested, because the
first regex I wrote matched neither). `docs/setup.md` now tells projects to
use `down -v --remove-orphans`.

---

## 2026-10-15: the phantom preview stack

Dogfooding #99 a second time turned up a confusing state: the page showed a
preview stack with no URL, and pressing Restart added what looked like another
build. Four things were wrong, all now fixed.

1. **`up` ran once and was never re-run.** The branch for #99 already existed
   from the first trial, so the worktree was that branch — which predated the
   `pr-demon-*` → `pr-daemon-*` rename, so `missingRecipe()` short-circuited
   `up` with "no such recipe" before running anything. The agent was told to
   fix it and did, but nothing re-ran `up`, so the row stayed empty and the PR
   would have shipped with "_not running_" as its preview. `build()` now calls
   `restartStack()` after the agent step and after each fix round (the loop
   already re-ran `up` but threw the result away), refreshing the row, the
   `PREVIEW_URL` the fix prompt sees, and the link in the PR.
2. **A failed `up` left a phantom row with no reason.** The error lived only
   in the agent's prompt file. `stacks` has an `error` column now (migrated
   with an `ALTER` on open), written by build, revise, restart and the health
   poll, and the page shows "not running" plus the error instead of a grey dot
   and a bare "no URL". `restart` on a stack whose worktree is gone now says
   so on the row and fails, rather than finishing instantly.
3. **Stack chores looked like builds.** Restart and Tear down enqueue jobs, so
   they appear in Work; they now read "restart stack" / "tear down stack ·
   no agent, no tokens". A queued job also says why it is waiting
   ("waiting: build #1 is running on this branch", or the agent-slot limit),
   and pressing the button twice no longer queues a duplicate — it logs that
   one is already queued or running.
4. **Cancelling left no trace.** `cancel()` writes an event and sets
   "cancelled by you" as the reason.

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
old self-hosted runner, the launchd aside comparing pr-daemon to it, the
"don't edit a running bash script" gotcha (there are no bash scripts any more),
and "built by the old prototype" on trial #97. What stays on purpose: the
dated journal entries that record the prototype and why it was dropped, the
PLAN.md row explaining why not GitHub Actions, and one line in CLAUDE.md's
decisions saying both were tried and shouldn't be reintroduced.

The runner turned out to be more than a stale note: the old runner was still
registered and **online** on framejs.app (label `pr-demon`, id 21). It's now
deregistered, so that repo has no self-hosted runners. The runner *service* on
that machine is still installed and will keep failing to connect — finish it there
with `./svc.sh stop && ./svc.sh uninstall` (and `./config.sh remove`). Also retired
the last of the just-only wording in PLAN.md and the code comments, since any
shell command works.

**The old installation is gone from this machine** (2026-10-15). An orphaned
`pr-demon serve` from 07:47 was still holding port 7377 — killed. Then
the old `pr-demon` checkout (only a leftover `node_modules`, no `.git`)
and `~/.pr-demon/` (512MB) were deleted. Before deleting the state directory
its one worktree's stack was torn down properly with `just pr-demon-down`:
**17 containers had been running for 19 hours**, and deleting the worktree
first would have orphaned them and their networks, which is most likely where
the leaked `framejs-nhost-frontend-*_default` networks came from. Nothing was
lost: the worktree was clean and fully pushed (PR #100 is open on the same
commit), `repos/` was a re-clonable cache, and `caddy/` regenerates.

One setting worth knowing was discarded with the old config: it had
`tokens = "40M"` and `per_issue = "10M"` under `[budget]`, and
`base = "pr-demon-setup"` for framejs.app. The current config has neither.

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

- **Set `proxy_host = "upstream"` for `metapages/framejs.io`** in the config:
  its previews answer 404 publicly while the stack answers fine locally (the
  status page now shows that as degraded and names the fix on the row).

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
4. **Decide when to make `dionjwa/pr-daemon` public.** It's written to be
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
