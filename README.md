# pr-daemon

**Label an issue. Get a pull request.**

You describe a feature in a GitHub issue and add the **`agent`** label.
pr-daemon, one process on **your own machine**, then:

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
  you                         pr-daemon (one process on your machine)                  you
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

| You do | pr-daemon does |
|---|---|
| Open an issue and describe the feature. | — |
| Add the **`agent`** label. | Within a minute: labels it `agent:working` and comments with the branch. |
| Wait. Watch at http://localhost:7377 if you like. | Builds, tests, opens a PR, reviews it, and labels the issue `agent:in-review`. |
| Open the **Preview** link in the PR and try it. | Keeps the stack running and restarts it if it stops. |
| Want changes? Comment on the PR: `/pr-daemon make the button blue`. | Makes the changes, pushes, and comments with a summary and new screenshots. |
| Merge (or close) the PR. | Stops the stack and removes the worktree. |

- **Out of budget?** The issue is labelled **`agent:paused`**. It resumes by
  itself when the budget window frees up, with the agent picking up where it
  stopped.
- **Stuck?** The issue is labelled **`agent:failed`** with the reason in a
  comment. Press **Retry** on the status page, or remove and re-add the
  `agent` label.
- Only **you** can trigger builds and `/pr-daemon` (or the people you list in
  `allowed_users`). pr-daemon checks who added the label.

---

## Setup (about 10 minutes)

### 1. Install the tools

You need Node 23.6 or newer, `git`, `gh`, `just`, `docker`, and Claude Code
(`claude`).

```bash
brew install node git gh just     # macOS; use your package manager on Linux
npm install -g @anthropic-ai/claude-code
gh auth login                     # pr-daemon acts as you, through gh
claude                            # log in once, then exit
```

### 2. Get pr-daemon

```bash
git clone https://github.com/metapages/pr-daemon ~/pr-daemon
cd ~/pr-daemon
ln -s ~/pr-daemon/bin/pr-daemon /usr/local/bin/pr-daemon    # optional: put it on your PATH
```

`just` with no arguments lists every command and prints this same checklist.
The commands below are `pr-daemon <command>`; from the checkout, `just
<command>` does the same thing (and installs the node modules on first run).

### 3. Tell it which repos to watch

```bash
pr-daemon doctor          # creates ~/.pr-daemon/config.toml and checks everything
```

Open `~/.pr-daemon/config.toml` (or the **Config** tab on the status page later)
and add your repo:

```toml
[[repos]]
name = "your-org/your-repo"
```

**More than one repo?** The double brackets mean "another item in the list", so
repeat the whole block — no commas, no indentation:

```toml
[[repos]]
name = "your-org/api"

[[repos]]
name = "your-org/website"
check = "just test"             # optional, and applies to website only
```

A block owns every line under it until the next `[[repos]]`, so keep a repo's
settings directly beneath its own `name`. The commented list at the bottom of
the config file has all the per-repo settings and their defaults.

You can also set a budget there, e.g. `tokens = "40M"` per 5-hour window.

### 4. Teach your project to start and stop itself

Your project needs two commands:

| Command | What it must do |
|---|---|
| `up` | Start **this branch's** whole stack **in the background**, wait until it answers, then **print its URL as the last line**. If it's already running, just print the URL. |
| `down` | Stop this branch's stack and delete its data. |

A third, `check`, is optional: whatever must pass before a PR opens, such as
type-check, lint and tests. Leave it out to trust the agent's own testing.

**Any shell command will do.** Each is run with `bash -lc` from the root of the
branch's worktree, so all of these are fine:

```toml
[[repos]]
name = "your-org/your-repo"
up = "docker compose up -d --wait && echo http://localhost:3000"
down = "docker compose down -v --remove-orphans"
check = "npm test"
```

The defaults (`just pr-daemon-up` / `-down` / `-check`) just mean that if you
add recipes with those names to your project, there's nothing to configure.
[`examples/justfile`](examples/justfile) is one to copy (`just contract`
prints it).

Two branches' stacks must be able to run at the same time, so derive ports and
container names from the branch name. Try your commands yourself on a branch
before letting an agent loose on them.

**Handing this to an agent:** the full contract — the rules, the environment,
the paths, a checklist — is one plain-text page. Open the **Setup** tab on the
status page and copy the line it gives you:

```
Set up this repo for pr-daemon: http://localhost:7377/setup
```

Paste that into a chat session open on your project, and the agent fetches the
page and does the work. Or read it yourself: `pr-daemon setup`.

### 5. Start it

```bash
pr-daemon doctor              # every line should be ✓
pr-daemon install-service     # starts now and at every login; logs: ~/.pr-daemon/pr-daemon.log
```

Open **http://localhost:7377**, then label an issue `agent`.

> Prefer a terminal? `pr-daemon serve` runs it in the foreground instead.

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

## Public preview URLs (optional)

Set a domain and each branch gets its own address, named after the branch:

```toml
[preview]
domain = "preview.example.com"   # → https://94-my-new-feature.preview.example.com
email = "you@example.com"        # optional, for Let's Encrypt notices
```

**Your part (once):**
- Point `*.preview.example.com` at this machine with a wildcard DNS record.
- Forward ports **80** and **443** to it, e.g. on your router.

**pr-daemon's part:**
- It runs **Caddy**: the `caddy` binary if it's installed (`brew install caddy`), otherwise a Docker container. You can force either with `proxy = "binary"` or `proxy = "docker"`.
- It keeps Caddy's routes equal to the running stacks: a new branch gets a route, and a torn-down one loses it.
- It gets an HTTPS certificate per branch host from Let's Encrypt automatically.
- If Caddy dies it's restarted. When pr-daemon stops, Caddy stops with it, so the preview URLs are down for a few seconds across a restart. (Preview stacks themselves keep running.) If pr-daemon is killed outright, the Caddy that's still running is adopted on the next start.

The PR's **Preview** link becomes the public URL, and the status page shows
both the public and the local address.

**Your app needs to know its public address.** `pr-daemon-up` receives:

| Variable | Example |
|---|---|
| `PR_DAEMON_PUBLIC_URL` | `https://94-my-new-feature.preview.example.com` |
| `PR_DAEMON_PUBLIC_HOST` | `94-my-new-feature.preview.example.com` |

Use them for anything that builds absolute URLs: auth redirect URLs, CORS
origins, cookie domains, and links to other services. Both are empty when no
domain is set.

If the app's dev server only accepts its local host name (Vite's
`allowedHosts`, for example), set `proxy_host = "upstream"` on the repo.
pr-daemon then forwards the app's local Host header instead of the public one.

**Testing without a domain:** use `domain = "pr-daemon.localhost"`,
`tls = "internal"`, `http_port = 8080` and `https_port = 8443`, then open
`https://<branch>.pr-daemon.localhost:8443`. Your browser will warn about
Caddy's local certificate.

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
- **While it runs:** pr-daemon counts tokens as they stream in. The moment a
  limit is reached it stops the agent, labels the issue `agent:paused`, and
  continues the same agent session once the window frees up.
- **Claude's own usage limit:** handled the same way. It waits for the reset,
  then continues.
- **Per-issue cap reached:** that issue waits for you. Raise `per_issue`, then
  press **Resume**.

## All settings

See the comments in `~/.pr-daemon/config.toml`. The main ones:

| Setting | Default | Meaning |
|---|---|---|
| `label` | `agent` | The issue label that starts a build |
| `allowed_users` | `[]` (only you) | Who may trigger builds and `/pr-daemon` |
| `concurrency` | `1` | Agent runs at the same time |
| `poll` | `60s` | How often to check GitHub |
| `agent.max_attempts` | `3` | Build → check → fix rounds before giving up |
| `agent.auto_revise` | `true` | The builder answers the reviewer once, automatically |
| `stacks.auto_restart` | `true` | Restart preview stacks that stop answering |
| `preview.domain` | unset | Public preview URLs `https://<branch>.<domain>` (pr-daemon runs Caddy) |
| `preview.proxy` | `auto` | `auto` / `binary` / `docker` / `off` |
| `preview.tls` | `auto` | `auto` (Let's Encrypt) / `internal` (testing) / `off` (plain http) |
| `[[repos]] up / down / check` | `just pr-daemon-up` / `-down` / `-check` | Override for projects without `just` |
| `[[repos]] proxy_host` | `public` | Host header the app sees through the preview proxy: `public` or `upstream` |

## Commands

```bash
pr-daemon serve                      # the process (install-service runs this for you)
pr-daemon status                     # running, queued and paused jobs, and stacks
pr-daemon doctor                     # check tools, logins, config
pr-daemon run build your-org/repo 42 # one job now, in this terminal (build|review|revise|teardown|restart)
pr-daemon install-service | uninstall-service
```

`pr-daemon setup` prints the project contract — the same page the **Setup**
tab hands to an agent, and the same text served at `/setup`. From the checkout, `just` lists these plus the development ones: `just start`
(the process in this terminal), `just dev` (the same, restarting on every code
change), `just check`, `just test`, `just logs`, `just restart` (restart the
installed service after changing the code), `just db`, `just contract`.

## Where things are

```
~/.pr-daemon/
  config.toml                       settings (also editable on the status page)
  pr-daemon.db                       jobs, token ledger, stacks, events (SQLite)
  pr-daemon.log                      the service's log
  repos/<org>__<repo>/              a cached clone
  worktrees/<org>__<repo>/42-…/     the branch the agent works in (the stack runs from here)
  out/<org>__<repo>/42-…/           prompts, agent logs (*.jsonl), PR text, screenshots
  caddy/                            the generated Caddy config, its log, and certificates (binary mode)
```

These are ordinary files and ordinary git checkouts: open a worktree, read it,
run `git log` in it. `just where` prints the list with the branches checked out
right now, the status page shows each stack's and each job's worktree, and
`<org>__<repo>` is just `owner/name` with the slash replaced (a slash can't be
a directory name). Leave them where they are, though — `down` runs from the
worktree before pr-daemon removes it.

## Safety

- The agent has full control of this machine while it works. Run pr-daemon as
  a dedicated user (or in a VM) if the machine holds anything you care about.
- pr-daemon acts as **your** GitHub user, through `gh`. It **never merges**:
  you do.
- Only allowed users (by default, only you) can start work. pr-daemon checks
  who added the label and who wrote each `/pr-daemon` comment.
- Nothing from the internet connects to pr-daemon itself: it only polls GitHub.
  The status page listens on 127.0.0.1 only and refuses requests from other
  websites. With a preview domain set, Caddy serves **only the preview
  stacks**, so anyone with a branch's URL can reach that preview. Treat
  previews as public, or put access control in the app.

See [PLAN.md](PLAN.md) for the design and roadmap.
