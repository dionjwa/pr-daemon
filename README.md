# pr-demon

**Label an issue. Get a pull request.**

You describe a feature in a GitHub issue and add the **`agent`** label.
pr-demon, one process on **your own machine**, then:

1. creates a branch, e.g. `42-dark-mode-toggle`
2. starts a full copy of your app for that branch
3. has an AI agent (Claude Code) build the feature and its tests, and keeps it
   going until your checks pass
4. opens a pull request with a description, screenshots, and a link to the
   running app
5. has a second agent, which sees only the PR, review it

**You** try it, then merge it. Merging or closing the PR shuts the app copy
down and cleans up. Everything runs within a **token budget** you set.

```
  you                         pr-demon (one process on your machine)                  you
  ───                         ──────────────────────────────────────                  ───
  issue #42 ──"agent"──▶  branch 42-dark-mode-toggle → start stack → agent builds
                          → checks pass? ──no──▶ agent fixes (repeat)
                          → yes: PR + screenshots + preview link
                          → fresh agent reviews the PR ─────────────────────────▶  try it, merge
                          stop stack, delete worktree  ◀────────────────────────────────┘
```

Status and settings are on a local web page: **http://localhost:7377**.

---

## Day to day

| You do | pr-demon does |
|---|---|
| Open an issue and describe the feature. | — |
| Add the **`agent`** label. | Within a minute: labels it `agent:working` and comments with the branch. |
| Wait. Watch at http://localhost:7377 if you like. | Builds, tests, opens a PR, reviews it, and labels the issue `agent:in-review`. |
| Open the **Preview** link in the PR and try it. | Keeps the stack running and restarts it if it stops. |
| Want changes? Comment on the PR: `/demon make the button blue`. | Makes the changes, pushes, and comments with a summary and new screenshots. |
| Merge (or close) the PR. | Stops the stack and removes the worktree. |

- **Out of budget?** The issue is labelled **`agent:paused`**. It resumes by
  itself when the budget window frees up, with the agent picking up where it
  stopped.
- **Stuck?** The issue is labelled **`agent:failed`** with the reason in a
  comment. Press **Retry** on the status page, or remove and re-add the
  `agent` label.
- Only **you** can trigger builds and `/demon` (or the people you list in
  `allowed_users`). pr-demon checks who added the label.

---

## Setup (about 10 minutes)

### 1. Install the tools

You need Node 23.6 or newer, `git`, `gh`, `just`, `docker`, and Claude Code
(`claude`).

```bash
brew install node git gh just     # macOS; use your package manager on Linux
npm install -g @anthropic-ai/claude-code
gh auth login                     # pr-demon acts as you, through gh
claude                            # log in once, then exit
```

### 2. Get pr-demon

```bash
git clone https://github.com/metapages/pr-demon ~/pr-demon
cd ~/pr-demon && npm install
ln -s ~/pr-demon/bin/pr-demon /usr/local/bin/pr-demon    # optional: put it on your PATH
```

### 3. Tell it which repos to watch

```bash
pr-demon doctor          # creates ~/.pr-demon/config.toml and checks everything
```

Open `~/.pr-demon/config.toml` (or the **Config** tab on the status page later)
and add your repo:

```toml
[[repos]]
name = "your-org/your-repo"
```

You can also set a budget there, e.g. `tokens = "40M"` per 5-hour window.

### 4. Teach your project to start and stop itself

Add two recipes to your project's `justfile`
(see [`examples/justfile`](examples/justfile)):

| Recipe | What it must do |
|---|---|
| `pr-demon-up` | Start **this branch's** whole stack **in the background**, wait until it answers, then **print its URL as the last line**. If it's already running, just print the URL. |
| `pr-demon-down` | Stop this branch's stack and delete its data. |

Optional third recipe: `pr-demon-check`. These are checks that must pass before
a PR opens, such as type-check, lint and tests. If you leave it out, pr-demon
trusts the agent's own testing.

Two branches' stacks must be able to run at the same time, so derive ports and
container names from the branch name. Try the recipes yourself on a branch:

```bash
just pr-demon-up && just pr-demon-down
```

### 5. Start it

```bash
pr-demon doctor              # every line should be ✓
pr-demon install-service     # starts now and at every login; logs: ~/.pr-demon/pr-demon.log
```

Open **http://localhost:7377**, then label an issue `agent`.

> Prefer a terminal? `pr-demon serve` runs it in the foreground instead.

---

## The status page

http://localhost:7377. It's only reachable from your own machine.

- **Token budget:** tokens used in the current window, the limit, and when it
  frees up.
- **Work:** every job (build, review, revise, teardown, restart) with its
  state, tokens and the reason it's waiting. Click a row to watch the agent
  live. Buttons: **Cancel**, **Resume** (continue where it stopped) and
  **Retry** (start over).
- **Preview stacks:** every running app copy, with a health dot. Buttons:
  **Restart**, **Tear down**.
- **Events:** what happened, newest first.
- **Pause:** stops new jobs from starting. Running ones finish.
- **Config:** edit the config file in place. It's checked before saving, so
  a typo can't break anything.

## Token budget

```toml
[budget]
window = "5h"              # rolling window; one Claude subscription window
tokens = "40M"             # per window (unset = no limit)
per_issue = "10M"          # per issue, across all its runs (unset = no limit)
count_cache_reads = true   # cache reads are ~90% of tokens; false counts only new tokens
```

For scale: the first trial issue (a small UI change) used about **2.8M tokens**
in total. That's 2.1M to build, 0.3M to review and 0.4M to revise, and around
94% of it was cache reads.

- **Before a job starts:** it waits until there's budget.
- **While it runs:** pr-demon counts tokens as they stream in. The moment a
  limit is reached it stops the agent, labels the issue `agent:paused`, and
  continues the same agent session once the window frees up.
- **Claude's own usage limit:** handled the same way. It waits for the reset,
  then continues.
- **Per-issue cap reached:** that issue waits for you. Raise `per_issue`, then
  press **Resume**.

## All settings

See the comments in `~/.pr-demon/config.toml`. The main ones:

| Setting | Default | Meaning |
|---|---|---|
| `label` | `agent` | The issue label that starts a build |
| `allowed_users` | `[]` (only you) | Who may trigger builds and `/demon` |
| `concurrency` | `1` | Agent runs at the same time |
| `poll` | `60s` | How often to check GitHub |
| `agent.max_attempts` | `3` | Build → check → fix rounds before giving up |
| `agent.auto_revise` | `true` | The builder answers the reviewer once, automatically |
| `stacks.auto_restart` | `true` | Restart preview stacks that stop answering |
| `[[repos]] up / down / check` | `just pr-demon-up` / `-down` / `-check` | Override for projects without `just` |

## Commands

```bash
pr-demon serve                      # the process (install-service runs this for you)
pr-demon status                     # running, queued and paused jobs, and stacks
pr-demon doctor                     # check tools, logins, config
pr-demon run build your-org/repo 42 # one job now, in this terminal (build|review|revise|teardown|restart)
pr-demon install-service | uninstall-service
```

## Where things are

```
~/.pr-demon/
  config.toml                       settings (also editable on the status page)
  pr-demon.db                       jobs, token ledger, stacks, events (SQLite)
  pr-demon.log                      the service's log
  repos/<org>__<repo>/              a cached clone
  worktrees/<org>__<repo>/42-…/     the branch the agent works in (the stack runs from here)
  out/<org>__<repo>/42-…/           prompts, agent logs (*.jsonl), PR text, screenshots
```

## Safety

- The agent has full control of this machine while it works. Run pr-demon as
  a dedicated user (or in a VM) if the machine holds anything you care about.
- pr-demon acts as **your** GitHub user, through `gh`. It **never merges**:
  you do.
- Only allowed users (by default, only you) can start work. pr-demon checks
  who added the label and who wrote each `/demon` comment.
- Nothing from the internet connects in: pr-demon only polls GitHub. The
  status page listens on 127.0.0.1 only and refuses requests from other
  websites.

See [PLAN.md](PLAN.md) for the design and roadmap.
