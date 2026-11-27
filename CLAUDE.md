# pr-daemon: context for agents working on this repo

Read this first (then journal.md for the history and next steps). It records the goals, the owner's decisions, how the code fits
together, and what we learned the hard way. User-facing docs are in README.md
(keep that one simple and step-by-step); the roadmap is in PLAN.md.

## What it is

Label a GitHub issue `agent`, get a pull request. Label an existing PR `agent`,
get its stack and a review. One long-running process on the owner's machine
(`pr-daemon serve`):

1. polls GitHub for issues (and PRs: see below) that just got the `agent`
   label, checking **who** added it
2. creates a worktree on a branch `<issue>-<short-kebab-summary>`
3. starts that branch's full stack (`just pr-daemon-up`, which prints the local URL)
4. runs headless Claude Code to build the feature and tests, then re-runs the
   project's check (`just pr-daemon-check`) and resumes the same session to fix
   failures, up to N rounds
5. pushes and opens a PR with a description, screenshots and a preview link
6. runs a **fresh** Claude session to review the PR (it sees only the PR), with
   one automatic revise round if the verdict is `changes` **or** its
   follow-ups list anything under `### Just do` (`reviewWantsRevise()`). The
   reviewer sorts non-blocking follow-ups into `### Just do` (one obvious fix)
   and `### Needs a decision` (left for a human); the revise prompt's
   `{{FROM_REVIEW}}` tells the builder to do the first, leave the second, and
   mark every item ✅ / ↩️ / 🙋 in its PR comment
7. watches **the repo's own CI** on the PR (check runs and commit statuses) and,
   when it goes red, runs an agent to fix it: once per failing head commit, up
   to `checks.max_rounds` per PR
8. watches whether the PR still **merges into its base** and, when it
   conflicts, merges the base in (never a rebase or force-push) with an agent
   resolving the conflicts; risky or uncertain ones go to a human. A PR
   that's idle and conflict-free but behind its base gets the same
   merge (`merge.catch_up`), so it stays ready to merge
9. `/pr-daemon <feedback>` comments on the PR trigger further revisions (a
   leading 😈, 👿, `:smiling_imp:`, `:imp:` or `:demon:` works too: `gh.parseCommand()`).
   On an **issue** with no PR yet, the same comment runs `discuss`: an agent
   reads the issue, the trusted conversation and the code (a detached
   checkout of the base, deleted after each run) and replies on the issue.
   It writes nothing. One Claude session per issue (kv
   `discuss-session:<repo>#<n>`), so each comment continues the conversation.
   Once the issue has an open PR, an issue comment revises that PR instead.
   Labelling the issue afterwards builds it **with** that conversation: the
   build prompt gets the issue's trusted comments (`buildDiscussion()`), since
   the builder can't resume the discuss session (different cwd).
10. when the PR closes (or the issue, before there's a PR), or the `agent` label
   is removed: `just pr-daemon-down`, remove the worktree, clear labels, and
   delete the branch on GitHub. Removing the label also cancels running jobs
   for the issue and closes its open PR. The page's Tear down button only
   runs `down`: the stack row stays as **stopped** (`stacks.stopped_at`),
   with its worktree and logs, so the work stays listed; the poll skips its
   health/CI/merge watches (they would bring it back), and Restart (or any
   `up`, via `bringUp()`) clears it. The page's "Issues and PRs" table is
   every stack row plus every labelled issue/PR with no stack yet
   (`Daemon.work()`; the branch and PR come from its build/adopt job). Such
   a row with a PR gets **Start**: a `restart` job with no stack row and
   `job.pr` set runs `pipeline.start()` — `prWorktree()` (trust check
   included), `bringUp()`, and the builder's session back on the row.
11. with `[preview] domain` set: runs Caddy so each branch is at
    `https://<branch>.<domain>`

**A second way in:** the `agent` label on a **PR** instead of an issue runs
`adopt` (`pipeline.adopt()`). It does the whole of steps 2–4 — worktree, the
project's own `up` with the same `publicEnv`, so the branch gets its **public
preview route** and service hosts exactly as a built one does; then `check`,
and `agent.max_attempts` fix rounds (`prompts/green.md`) to drive it green,
committed and pushed — and then the review of 6; 7–11 watch it afterwards like
any other PR. The only thing it skips is writing a feature, because the code
is already in the PR. The branch is somebody else's, so teardown never deletes
it and the PR is never closed; a fork, or a PR whose title/body has a writer
outside `allowed_users`, is refused with a comment on the PR.

**The state machines are a page:** `src/docs.html`, served at
`GET /docs` (linked from the status page's nav). Four `stateDiagram-v2`
diagrams — the labelled issue/PR, the in-review watch loop, one job, one stack
— plus the issue-vs-PR table that says what each entry point gets. Keep it
true when the lifecycle changes; it is the fastest way to see what pr-daemon
does. Mermaid is fetched from a CDN there and **fails soft** (an unrendered
diagram is still its own source), which is the one network dependency any
pr-daemon page has.

All agent work happens within a token budget (rolling window plus per-issue cap).
A human always merges.

## The owner's decisions (don't change these without asking)

- **One host process.** Not GitHub Actions, and not a self-hosted runner: both
  were tried and dropped (too much per-repo setup, no control over token use).
  Don't reintroduce them.
- **It can be that one process in a container** (`docker/`, `docs/container.md`),
  and that is the recommended way to run it. The reason is blast radius: on a
  host install an agent can read everything the owner can. In the container the
  only host things it can reach are **three mounts and the Docker socket**:
    - **config** (`CONFIG_HOME`): `config.toml`. Writable (the page saves it),
      and the mount is the *directory* — a save renames a temp file over
      config.toml, which a bind-mounted file refuses.
    - **credentials** (`CREDENTIALS_HOME`): `claude-token`, `gh-token`,
      `gh-tokens/<owner>`, `cloudflare-token`, `secrets/<org>__<repo>.env`.
      Mounted **read-only**: pr-daemon never writes any of them, so nothing in
      the container can add or widen a login.
    - **work** (`WORK_HOME`): `repos/`, `worktrees/`, `out/`, `refs/`,
      `assets/`, `caddy/`, the database and the log.
  The first two are backed up, the third is not; the **database goes with the
  work disk**, because its rows name worktrees on it. All three default to
  `PR_DAEMON_HOME`, so a host install is still one directory and nothing about
  it changed. Don't move a path across roots without asking which backup class
  it belongs to.
- **The work disk is mounted at the same path inside and outside.** Not
  negotiable: a preview stack's `docker compose` talks to the **host's**
  Docker, so every bind mount in the project's compose file is resolved by the
  host. A worktree at a container-only path means a stack that comes up with
  empty mounts and nothing saying why. `doctor` verifies it for real — it
  writes a marker into the work disk and has a sibling container read it back
  through the same path.
- **The Docker socket is the one hole, and it is admitted, not hidden.**
  Anything that can use it can get root on the host. It is mounted because
  previews *are* containers; the honest framing (README, docs/container.md) is
  "this stops an agent wandering into your home directory, it is not a
  sandbox". Don't add security theatre around it. The alternatives, in order of
  effort, are in docs/container.md; the real fix (a separate Docker daemon for
  previews) is not wired up because the published ports would move with it.
- **Node + TypeScript**, run directly (Node ≥ 23.6 strips types; no build
  step). Only syntax that can be stripped: no enums, namespaces or parameter
  properties, and imports use `.ts` extensions.
- **SQLite via built-in `node:sqlite`** for jobs, the token ledger, stacks,
  events and kv. No native modules.
- **Config is one TOML file** (`~/.pr-daemon/config.toml`). The status page
  edits the **raw text**, so comments survive. It's validated before it's
  written, and changes apply live.
- **Status page** on `127.0.0.1:7377` only, or also at
  `https://pr-daemon.<domain>` behind Caddy basic auth when `[preview]
  page_user` and `page_password_hash` (bcrypt, from `caddy hash-password`)
  are both set. Never online without the login: the page edits config.toml,
  whose commands run here. Caddy sends web.ts a local Host, so its Host check
  stays as it is. Vanilla HTML in `src/ui.html`, no
  framework, no build, **no `alert`/`confirm` dialogs** (click twice to
  confirm). Three tabs, routed off `location.hash`: Status, Setup (who it acts as, how to use it, the line to
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
  every build start. `github-actions[bot]` (every workflow's `GITHUB_TOKEN`)
  is allowed **per repo** (`[[repos]] actions = true`) and only while the repo
  is private (`gh.repoBots()`, `gh.isPrivate()`); `parseConfig()` refuses it in
  `allowed_users`. GraphQL spells bots without `[bot]`, so `provenance()`
  normalizes with `gh.graphqlLogin()`. Revise prompts only get PR comments from trusted authors
  (`gh.trustedDiscussion()`: allowed users plus the gh user). Agents are
  told not to fetch comments themselves; don't reintroduce `--comments`.
  A PR's **code** is agent input too: every commit's author and committer
  must be trusted (`gh.untrustedCommits()`, `web-flow` defers to the author),
  checked by `trustCode()` at the start of every job on a PR (`adopt` and
  `prWorktree()`), because anyone with write access can push at any time.
  The status page, `status` and `doctor` all name the gh user it acts as,
  which login that is (`ghAuth()`) and who is allowed (`status().github`);
  keep that visible. The README's Safety
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
  **Catch-up** (`Daemon.catchUp()`, rules in `merge.catchUpBlocker()`):
  GitHub only reports `behind` under branch protection, so an idle PR asks
  `gh.behind()` (compare) at most every `checks.every`. CI doesn't hold it:
  running CI is for a head the merge replaces (waiting runs it twice), and red
  CI may be the base's own failure, fixed there since (seen: superslides.io
  #177, whose `ci` agent rightly changed nothing). So `pollChecks()` tries a
  catch-up first when CI goes red and only queues the `ci` agent once that's
  been tried for the head + base tip. The
  trigger is head sha + base tip. A failed/cancelled last job or a "needs
  your review" holds it until the PR head moves.
- **Workflow files are per-repo opt-in** (`[[repos]] workflows = true`,
  default false). A workflow runs with the repo's secrets, so: off, an
  agent's `.github/workflows/` edit is stripped before the push and posted for
  a human (`git.stripWorkflows()`), whatever the login can do; on, the
  prompts' `{{WORKFLOWS}}` (`workflowsNote()`) allow narrow edits, the push
  goes through and is flagged **needs your review** (`git.pushedWorkflowComment()`
  with the diff and an undo block, a warn notice, and the review notice names
  the files), workflow merge conflicts become a caution instead of a blocker,
  and a push GitHub refuses (`git.WorkflowRefused`) falls back to holding back.
  The intended login is fine-grained tokens limited to the configured repos.
  A fine-grained token has ONE resource owner (an account or an org), and the
  owner's repos span both, so it's one file per owner, `~/.pr-daemon/gh-tokens/<owner>`
  (any case), with `gh-token` for owners without one (`ghAuth()` in util.ts).
  `asOwner()` (an AsyncLocalStorage) wraps each repo's poll and each job in
  `launch()`, and `cleanEnv()` gives every child started inside it that
  owner's token as `GH_TOKEN`, so gh, git's `gh auth git-credential`, agents
  and stacks all use it. A gh call outside `asOwner()` gets the default.
  The owner's own gh login is left without the `workflow` scope. A fine-grained token reports no scopes, so
  `hasWorkflowScope()` assumes yes for one. The owner was tired of holding
  every workflow change by hand; don't turn the default back on without asking.
- **Trigger label is `agent`,** on an issue (build it) or on a PR (adopt it).
  Status labels are `agent:working`, `agent:in-review`, `agent:paused` and
  `agent:failed`, on whichever was labelled.
- **An adopted PR gets the same treatment as a built one**, minus writing the
  feature. Same `up`, same `publicEnv`, same stack row, so the same
  `https://<branch>.<domain>` route, health probes and auto-restart; and the
  same `check` + fix rounds, so a human never reviews a red PR. The owner
  always wants to try the public URL and always wants it green first, so "it
  only reviews" is never the right shortcut. The reviewing agent is told the
  address too (`previewNote()` → the review prompt's `{{PREVIEW}}`), since an
  adopted PR's body doesn't carry it.
- **`prompts/green.md` is written for somebody else's code.** Fix the cause,
  never the check; no refactors, no reverting the author; "a human has to do
  this" is an allowed outcome. That restraint is the whole prompt — don't
  turn it into a second builder. A round that changes nothing is reported as
  such and the PR is still reviewed: a red check is a reason to read the code,
  not to skip reading it.
- **Another repository is cloned, not configured.** An issue can say "do it
  the way `org/other` does", and `pr-daemon ref <owner/repo>` (run by the
  agent from its worktree) prints a read-only shallow clone of it. No config:
  `gh` is the owner's own login, so every repo they can read is already
  reachable, and a list of "reference repos" in config.toml was tried on
  paper and dropped — nobody would remember what it meant. The guarantees are
  in the clone, not in the prompt: it lives under `refs/`, **outside** the
  worktree (so it is invisible to `git status`, `add -u`, the project's
  `check` and any build context), `--depth 1 --single-branch --no-tags`,
  `remote.origin.pushurl` and `core.hooksPath` both `/dev/null` (an agent
  cannot push to somebody else's repo, and a cloned repo's hooks never run).
  One directory per branch, so concurrent agents never share a git index and
  `teardown` deletes it with the worktree. `git.refsFor()` is the whole
  "configuration": a pure path mapping from a worktree to its refs directory.
- **An adopted PR is somebody else's work.** Keep it that way: no force-push,
  no branch deletion, no closing the PR, and its description is left alone
  (the preview link is a comment). A fork is refused — pr-daemon makes a
  worktree from the branch and pushes fixes to it, which a fork's branch
  can't do — and so is a PR whose title or body has an untrusted writer,
  since that text is the reviewer's input. One number for everything: an adopted stack's
  `issue` **is** its PR number, and `pipeline.issueForPr()` is the one place
  that knows how a branch maps to the number its budget and status label use
  (the stack row first, then pr-daemon's own `<issue>-…` prefix).
- **Budget:** optional tokens per rolling window (default `5h`, one Claude
  subscription window), in human amounts (`"40M"`), plus an optional
  `per_issue` cap. Hitting the window limit pauses and auto-resumes. Hitting
  the per-issue cap pauses until a human presses Resume.
- **Portable:** a project only adds `pr-daemon-up` (start in the background,
  print the URL last) and `pr-daemon-down`. `pr-daemon-check` is optional. Every
  command can be overridden per repo.
- **A restart is `down` then `up`, for every project.** Not a per-project
  command: that was tried and dropped as too complicated for each stack to
  implement. `up` alone won't do, because it leaves a running stack as it was.
  On an open PR, `restart()` first runs `trustCode()` and `git.pullBranch()`
  (ff-only), so a push made outside pr-daemon is what comes up; a branch
  that can't fast-forward fails the restart before `down`.
  Between restarts, `pollPull()` compares each running stack's worktree HEAD
  with its PR's head on GitHub and queues a `pull` job (one per GitHub sha):
  `trustCode()` plus `git.pullBranch()`, no `down`/`up`, so the project's dev
  servers hot-reload a push made on another machine. The row shows the first
  5 characters of the worktree's commit.
  `down` gets `PR_DAEMON_KEEP_DATA=1` on a restart and on nothing else, an
  environment variable because `down` is an arbitrary command line and a flag
  would break the ones that don't expect it. Deleting stays the default: a
  project that ignores it loses the branch's data on every restart, automatic
  ones too, so the button confirms and `pollHealth()` won't queue one while
  work is on the branch.
- **Public previews:** the owner routes `*.<domain>` (DNS plus ports 80/443) to
  the machine. pr-daemon owns Caddy (binary or Docker) and the routing.
- **Notifications mean "your move".** `Daemon.attention()` records a notice
  (the `notices` table) and, with `notify`, sends it to the desktop
  (terminal-notifier on macOS). Each job sets `ctx.notice` to what it would
  say if it were the last; the daemon sends it only when `pendingOn()` finds
  no more work coming on the branch, so build → review → revise is one notice.
  Failures and pauses that need Resume notify too; starts, stacks coming
  up, clean merges and budget pauses never do. Each notice has a `kind`, and
  `notify_on` (a checkbox per kind beside the Config editor) switches kinds
  off. The checkboxes save through `setTopLevel()`, which rewrites that one
  line of config.toml so the comments survive. The page lists them under
  Needs you and shows new ones as browser notifications; the Setup tab checks
  the machine and sends a test. When an issue or PR closes, its notices go
  too (`Store.clearNotices()`, and `unnotify()` for the desktop): `teardown`
  clears the ones with a stack, and the poll clears the rest.
- **When the owner has to act, hand them every step.** Each PR comment,
  notice or error that asks a human to do something carries the exact
  commands, filled in, in one block (plus the browser way, and how to back
  out). The rules are in `.claude/skills/hand-over/SKILL.md`.
- **The repo will be public.** No secrets, hostnames, IPs or personal paths in
  code or docs.
- Commands in docs are `just` recipes where a project is involved. Keep the
  README step-by-step and plain.

## Code map (`src/`)

| File | Responsibility |
|---|---|
| `cli.ts` | Commands: `serve`, `status`, `stop`, `doctor`, `setup`, `ref <owner/repo>`, `run <kind> <repo> <n>`, `install-service` / `uninstall-service` (launchd plist / systemd user unit) |
| `daemon.ts` | The process: GitHub poll loop, scheduler (priority, concurrency, per-branch locks, budget gate), job launch and error→state mapping, page actions, `status()` JSON |
| `pipeline.ts` | The jobs (`JOBS`): `build`, `adopt`, `review`, `revise`, `discuss`, `ci`, `merge`, `teardown`, `restart`, `pull`. `bringUp()` is the one place that runs `up` and writes the stack row. `agentStep()` runs Claude under the budget. Prompt templates are rendered from `prompts/*.md` with a single-pass `{{VAR}}` |
| `agent.ts` | Spawns `claude -p --output-format stream-json --verbose`, with `--session-id` for new sessions and `--resume` to continue. Live usage deltas, tool-activity lines, stall timer, kill switch, rate-limit detection |
| `transcript.ts` | Parses an agent's `*.jsonl` log into what it said, each tool call and its result, for `GET /api/jobs/<id>/transcript?from=N` (the page polls for new entries). `agentLog(job)` in `pipeline.ts` is the one place that knows each job's log path |
| `merge.ts` | The pure merge decisions: `assessConflicts()` (agent or human), `hasConflictMarkers()`, `parseMergeReport()` (the agent's `CONFIDENCE` / `NEEDS_HUMAN` trailer), `reviewReasons()` (what makes a pushed merge "needs your review"). The git side (`startMerge`, `conflicts`, `abortMerge`, `commitMerge`) is in `git.ts` |
| `budget.ts` | Rolling-window sum, per-issue sum, `gate()`, and when the window frees up |
| `proxy.ts` | Caddy supervisor. `caddyConfig()` is pure (unit-tested): routes are rebuilt from the stacks table every 5s and loaded via the admin API when the hash changes |
| `db.ts` | Schema plus `Store` (jobs, usage, stacks, events, kv) |
| `gh.ts` / `git.ts` / `stack.ts` | Wrappers for `gh` (as the user), the cached clone plus worktrees plus the screenshot branch plus reference clones (`refsFor`, `addReference`), and the project's up/down/check commands. `gh.summarizeChecks()` reduces check runs + commit statuses to one verdict; `stack.previewHealth()` turns the two health probes into up/degraded/down (both pure, unit-tested) |
| `hosts.ts` | Only in a container: the block of preview names pr-daemon keeps in its **own** `/etc/hosts`, rebuilt from the stacks table like the Caddy routes, so agents, Playwright and curl can reach a preview from in there. `stackNames()` and `hostsBlock()` are pure and unit-tested |
| `config.ts` | `DEFAULT_TOML` (the documented template), `parseConfig()` with readable errors, atomic save |
| `web.ts` / `ui.html` / `docs.html` | The localhost API (Host check; writes need `X-PR-Daemon: 1`), the status page, and `GET /docs`: the state machines as mermaid diagrams |
| `docker/` | `Dockerfile` (the daemon plus the tools a target repo needs: git, gh, just, docker CLI + compose, node, deno, python, build-essential, chromium, claude), `compose.yaml` (the three mounts, the socket, the capabilities it drops) and `entrypoint.sh` (uid/gid to match the work disk, the socket's group, git's identity, `/etc/hosts`, then drop privileges) |
| `setup.ts` / `docs/setup.md` | `paths()` (the runtime directories) and `setupDoc()`: the project contract with this machine's real paths and commands filled in, served as plain text at `GET /setup` and printed by `pr-daemon setup` |
| `util.ts` | `HOME` and the three roots (`CONFIG_HOME` / `CREDENTIALS_HOME` / `WORK_HOME`), amounts/durations, `run`/`sh`/`must`, `cleanEnv`, `ghAuth` / `asOwner` (the per-owner GitHub tokens), and the container's view of the host: `LOCAL_HOST`, `inContainer()`, `viaHost()`, `viaHostCurl()` |

The repo's own `justfile` wraps the CLI plus the dev commands; `examples/justfile` is the contract a target project implements.

**One PR, two origins:** a PR pr-daemon opened sits on a branch it named
`<issue>-<summary>`; an adopted one sits on a branch a person named, which can
be anything (slashes included). So no PR job guesses a worktree from a number:
`prWorktree()` takes the PR's own head ref and `git.ensureBranchWorktree()`
makes or reuses the worktree for it.

**Job lifecycle:** `queued → running → done | failed | cancelled | paused`, and
`ignored` for a trigger pr-daemon decided not to act on (a disallowed user, or
a failing check it won't fix because of `fix`/`max_rounds`) — the row records
the decision so it isn't taken twice. Each job has a unique `trigger_key`
(label event id, comment id, …), so a GitHub event triggers exactly once. A
paused or crashed job keeps its `session_id`, and resuming continues that
Claude session. On startup, `running` jobs are re-queued.

**Runtime files:** on a host install everything lives in `~/.pr-daemon/`; in a
container the same tree is split across three mounts by backup class (see the
decision above), which is what `CONFIG_HOME`, `CREDENTIALS_HOME` and
`WORK_HOME` in `util.ts` are for. The files: `config.toml`,
`pr-daemon.db`, `pr-daemon.log`, `claude-token` (optional), `gh-tokens/<owner>` and `gh-token`
(optional: pr-daemon's GitHub logins, see the workflow decision above), `repos/` (cached
clones), `worktrees/`, `out/` (prompts, agent `*.jsonl` logs, PR text,
screenshots), `refs/` (read-only clones of other repos an agent was asked to
look at, one directory per branch), `assets/` (the screenshot branch clone), `secrets/<org>__<repo>.env` (a
repo's dev API keys, written by the owner: `up`/`down`/`check` and agents get
its **path** as `PR_DAEMON_SECRETS` when it exists, from `secretsEnv()`; the
project's `up` reads the keys it wants, pr-daemon never reads the values),
`caddy/`.

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

just container-build          # the image: the daemon plus the tools a target repo needs
just container-up             # run it from docker/compose.yaml (settings in docker/.env)
just container-doctor         # doctor from inside it, as the daemon's own user
just container-shell          # a shell in there, as that user
just container-restart        # rebuild and restart: how a code change is picked up
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
- **Pushes touching `.github/workflows/` are rejected** when the login lacks
  the `workflow` scope (or a fine-grained token lacks Workflows write). Agent
  work is pushed through `pushWork()`: for a repo without `workflows = true`
  (or after such a refusal) it first takes a workflow edit out of the unpushed
  commits (`git.stripWorkflows()`, squashing them into one; never across a
  merge), pushes the rest, and posts the held-back diff on the PR for a human.
  `git.push()` explains a refusal that still happens. **A new branch is
  compared with the default branch**, not with its own commits: when a
  workflow change lands on the base while the agent works, the branch's
  first push looks like it undoes it and is refused although no commit of
  ours touches a workflow (superslides.io #204/#205). `pushWork()` then
  merges the base in first (`git.catchUpWorkflows()`, build only: later
  pushes are compared with the branch's old tip).
- **A fine-grained token may get 403 on check-runs** ("Resource not
  accessible by personal access token": it needs Checks, which the token page
  may not offer). `gh.checks()` then reads the Actions jobs of the commit's
  workflow runs (`actionsJobs()`): Actions makes one check run per job, so
  it's the same list minus other apps' checks (kodiak, GitGuardian).
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
- **Two stacks can share a port.** superslides.io derives ports from a hash
  of the branch name, and 260 and 266 got the same slot: 266's `up` printed
  13791, which 260's vite already held, so 266's preview went to 260's server
  ("host not allowed"). `stack.portClashes()` compares the ports of every
  running stack's URL and routes, and the row shows **⚠ port clash** with
  `clashMessage()` (what to tear down, and how to see who holds the port).
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
- **A background child can hold `up`'s pipes open forever.** `run()` used
  to resolve only on `close`, which waits for every holder of stdout/stderr.
  superslides' `up` did `exec 3>&1 1>&2` and then started its dev server with
  `nohup … >>log 2>&1 </dev/null &`, so the server inherited fd 3 (our stdout):
  three builds sat in `running` for hours with no agent and no stack row, and
  the 30-minute timeout didn't help because it SIGTERMed a bash that had
  already exited. `run()` now stops reading `STREAM_GRACE_MS` after `exit` (or
  after the timeout, which kills the whole group when `detached`). Diagnose
  with `lsof -p <pr-daemon pid> | grep unix` and `lsof -p <server pid> -d 0-5`.
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
- **Check the proxy on its own:** Caddy answers `https://pr-daemon.<domain>/proxy-check`
  itself, with no login even when the status page is on that host, and
  `doctor` fetches it. When debugging, also look for
  `rateLimited` in `~/.pr-daemon/caddy/caddy.log`: 5 failed certificate
  attempts on a host (e.g. while DNS was wrong) lock that host out for an hour,
  and `just dev` restarting Caddy on every edit burns through attempts fast.
- **Caddy writes and rolls its own log** (`logging` in `caddyConfig()`: 10 MB
  × 5, gzipped). The admin API's lines are excluded: pr-daemon's 5-second
  alive check made a 170 MB log of almost nothing else. What Caddy prints
  before its config loads (start-up errors, panics) is in `caddy-start.log`,
  truncated on each launch; Docker mode caps `docker logs` instead.
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
- **The service and an SSH shell see different Claude logins (macOS).** Claude
  keeps its login in the Keychain and falls back to `~/.claude/.credentials.json`
  when it can't read it. An SSH session can't ("User interaction is not
  allowed"), so a `/login` there only refreshes the file, while the launchd
  service, in the desktop session, reads the Keychain. Seen here: the Keychain
  entry had `expiresAt: 0`, and every agent failed in ~80ms with "OAuth session
  expired and could not be refreshed" while every test from SSH passed.
  The fix is `~/.pr-daemon/claude-token` (a `claude setup-token` token, mode 600):
  `claudeEnv()` in `agent.ts` gives it to every `claude` pr-daemon starts as
  `CLAUDE_CODE_OAUTH_TOKEN`, read on each run, and not to stacks. `doctor`
  tests with the same env and names the source. When debugging auth, test
  from the service's context, not an SSH shell.
- **A session to resume can vanish.** Revise and CI jobs resume the builder's Claude session (context plus a warm cache), but the transcript under `~/.claude/projects/<cwd>/` can be deleted out from under us, and `--resume` then fails with "No conversation found with session ID". `agentStep()` takes a `fresh` prompt and starts a new session from it in that case; every resume site passes the full prompt, which carries all the context the job needs (issue, PR, trusted discussion). Revise/CI then record the session they used as the stack's `builder_session`.
- **Agents read the target project's CLAUDE.md and skills** from the worktree.
  Project knowledge belongs there, not in pr-daemon's prompts.
- **In a container, `localhost` is the container.** Everything that assumed
  otherwise had to be fixed, and each fix is deliberate:
  - **The status page was bound to `127.0.0.1`,** which Docker's published port
    cannot reach: the port forwarder dials the *container's address*, not its
    loopback. It connected and then got an empty reply (curl exit 52). In a
    container `web.ts` binds `0.0.0.0`; that is still safe, because the port is
    published to the host's loopback only and the Host check already refuses
    anything but a local name.
  - **Health probes use `curl --resolve`, not a rewritten URL.** The request
    goes to the host while the `Host` header and the TLS name stay what the URL
    says — which is the whole point of those two probes (is it running vs. can
    a person open it). A rewritten Host would answer a different question.
  - **Caddy's admin API is reached by container name** over a shared network
    (`PR_DAEMON_DOCKER_NETWORK`), and its admin port is then published nowhere.
    Publishing it to `127.0.0.1` on a **Linux** host is not reachable through
    `host-gateway` at all, and publishing it on every interface would put
    Caddy's admin API on the LAN.
  - **`proxyTo()` sends everything to `host.docker.internal` in docker mode,**
    which is right for stacks (they are all on the host) and wrong for the
    status page, which is a container on Caddy's own network. Hence the
    `dialHost` override and `PR_DAEMON_SELF_HOST`.
  - **Public preview names** can't be fixed by either: an agent's curl or
    Playwright gets no flag from us. `hosts.ts` keeps a managed block in the
    container's own `/etc/hosts`. That file is a bind mount, so it must be
    written **in place** (a rename over it fails) and it arrives **root-owned**,
    so `entrypoint.sh` chowns it before dropping privileges. Only `localhost`
    and `127.0.0.1` are kept out of the block — a name *under* localhost
    (`app.localhost`, and the whole `domain = "pr-daemon.localhost"` testing
    mode) is a host address and has to be in it.
  - **The local URL an agent is told is not the one a person opens,** so with
    no preview domain `stackWhere()` names both and says which belongs in the
    PR. Human-facing text (the PR body, the PR comments, the status page) uses
    the stack row's own URL and is never rewritten.
- **`tini` as the ENTRYPOINT plus compose's `init: true` means no reaping at
  all:** tini warns it isn't PID 1 and isn't a subreaper, and zombies pile up.
  The image uses `tini -s` (register as a subreaper, so it works either way)
  and `compose.yaml` leaves `init` off, so there is one init and not two.
- **`docker compose exec` runs as root,** because the image's user *is* root —
  the entrypoint is what drops privileges. So `container-doctor` and
  `container-shell` pass `-u pr-daemon`; without it doctor's write tests pass
  trivially and tell you nothing about the user the daemon actually runs as.
- **On Docker Desktop the socket is root-owned (gid 0),** so the container user
  has to be in group 0 to use it. The entrypoint says so in the log rather than
  doing it quietly. Never `chmod` the socket: that inode is the host's.
- **A `.localhost` preview domain cannot work in a container, and /etc/hosts
  can't fix it.** curl and Chrome resolve every `*.localhost` name to loopback
  themselves (RFC 6761) and never read the hosts file, so an agent opening
  `https://4-x.pr-daemon.localhost:8443` reaches the container. The owner's own
  browser is fine, and the probes are fine (`--resolve` does override it), but
  agents, Playwright and the screenshots are not. Any other name works, real or
  made-up (pr-daemon writes the entries itself), and `doctor` says so. The
  block still lists `*.localhost` names for the tools that do read it (`getent`
  does).
- **A bind mount delivers no inotify events for an edit made on the host**
  (Docker Desktop's file sharing drops them), so `watchConfig()`'s directory
  watch never fires for the owner's own editor — the Config tab worked and a
  hand edit silently didn't. `reloadConfig()` already compares the text with
  what it last applied, so it is now also called every `CONFIG_RECHECK_MS`
  (5s): the watch became an optimisation rather than the only mechanism.
  `apply()` re-syncs the preview names too, so a new domain doesn't wait for
  the next poll.
- **The image needs the tools the target projects use, and `doctor` cannot
  tell you which.** metapages/superslides.io and framejs.app start their stacks
  with the **nhost CLI**, which wasn't in the image — so `up` *and* `down`
  failed for every superslides branch the moment pr-daemon moved into a
  container, which is also why nothing was destroyed. Hence
  `PR_DAEMON_EXTRA_SETUP` in docker/.env: one shell line run as root during the
  build (`EXTRA_SETUP` in the Dockerfile), pinned to a version. Debian packages
  still go in `PR_DAEMON_EXTRA_APT`. Read the target projects' justfiles for
  what they call; a missing tool shows up only as a stack whose `up` fails.
- **A failed `up` must not forget the address.** Caddy's routes are built from
  `stacks.url`, so writing `""` there on failure took three working previews off
  the proxy — public 404, while their servers were still running and answering
  locally. `restart` already kept the old url; `bringUp()` and the build's
  re-`up` now do too. `healthy: 0` and `error` are what record the failure.
- **Never open the database from the host while the container runs.** A bind
  mount shares no file locks between the host and the container, so two SQLite
  connections cannot see each other at all. The one on the host finds a WAL
  nobody appears to hold, recovers it, and on close **checkpoints and unlinks
  it** — while the daemon goes on writing to that now-nameless inode, where
  every commit is lost. One `sqlite3` on the host cost three job rows here, and
  the only sign was `pr-daemon.db-wal (deleted)` in `/proc/<pid>/fd`. So
  `openDb()` opens the database **read-only** outside the container whenever
  the daemon's marker is there (`.daemon-in-a-container` on the work disk,
  written at startup and removed on shutdown), and `just db` runs sqlite3
  inside the container when one is up. Inside, it is an ordinary file on an
  ordinary mount and the usual rules hold (verified: a second process sees the
  daemon's commits). `just logs` is safe either way — a log file has no locks.
- **A container has no `gh auth login`, and that silently cost the git identity.**
  gh's own login can't exist in there (read-only credentials, no browser), so
  every call goes through a token file. The calls `asOwner()` wraps were fine;
  the one with no owner was not — `gh.viewer()`, which is how the daemon learns
  who it acts as, and whose answer `start()` feeds to `git.ensureIdentity()`.
  Its rejection was swallowed by a `.catch(() => {})`, so the daemon polled and
  built normally and the first agent commit would have failed with "Please tell
  me who you are". Two fixes: `ghTokenFile()` borrows any `gh-tokens/<owner>`
  file when there is no `gh-token` and gh has no login of its own (they are all
  the same GitHub user), and `noteViewer()` is called from the first poll too,
  not only from `start()`.
- **`doctor` may only use tools the image has.** The DNS check shelled out to
  `dig`, which isn't in the container, so it reported the owner's working
  wildcard as broken. It uses `node:dns` now (`resolve4`, then `resolveCname`
  for the chain, which is the diagnostic that matters). `dnsutils` is in the
  image as well, for the agents.
- **Two places name the page's port in a container** — compose publishes
  `PR_DAEMON_PORT`, the page listens on `config.toml`'s `port`. Nothing answers
  if they differ, so `doctor` compares them.
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

- **In a container, a stack whose `up` starts a host process moves inside the
  container with it.** superslides.io branches differ: `mobile-upgrade-with-login`
  runs its frontend as a container (published port, works unchanged), while
  `282-review-tests-and-ci` and `284-production-build-issues` run deno bound to
  the host's 127.0.0.1. Started from inside the container those servers listen
  in there, where no browser and no Caddy can reach them. The nhost backend is
  containers either way. So this deployment wants those frontends containerised;
  publishing a port range doesn't help while the ports come from a hash of the
  branch name. The same applies to metapages/public-compute-grid, whose whole
  stack is a plain dev server (verified: it came up inside the container and
  answered only in there).

## Open items

See PLAN.md. In short:
- a real domain with 80/443 forwarded
- framejs.app public origins
- teardown on a real PR merge, verified end to end
- optional access control for previews
- per-PR spend in the description
