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
6. watches your repository's own CI on the PR and fixes it if it goes red
7. keeps the PR mergeable: when it conflicts with `main`, merges `main` in and
   resolves the conflicts, and hands you the risky ones

**Already have a pull request?** Label *it* `agent` instead. It gets steps 2,
3 and 5–7: the **same** app copy on the **same public preview URL** as a PR
pr-daemon wrote, your checks driven green (an agent fixes failures and pushes
to the branch), a review from a fresh agent, then `/pr-daemon` revisions, CI
fixes and base merges for the rest of its life. The only thing it doesn't do
is write a feature — the code is already there. It never force-pushes, never
deletes your branch and never closes your PR.

**You** try it, then merge it. Merging or closing the PR shuts the app copy
down, deletes the branch and cleans up. Changed your mind? Remove the `agent`
label and it stops and cleans up the same way. Everything runs within a **token budget** you set.

```
  you                         pr-daemon (one process on your machine)                  you
  ───                         ──────────────────────────────────────                  ───
  issue #42 ──"agent"──▶  branch 42-dark-mode-toggle → start stack → agent builds
                          → checks pass? ──no──▶ agent fixes (repeat)
                          → yes: PR + screenshots + preview link
                          → fresh agent reviews the PR
                          → your CI runs: red? ──▶ agent fixes it (twice at most) ─▶  try it, merge
                          → conflicts with main? ──▶ merge main in, agent resolves
                            (risky or unsure ──▶ asks you)
                          stop stack, delete worktree  ◀────────────────────────────────┘
```

Status and settings are on a local web page: **http://localhost:7377** —
and **http://localhost:7377/docs** draws the whole thing as state machines.

> **pr-daemon acts as you.** It uses your own `gh` login, so every branch,
> push, PR and comment it makes is made **as your GitHub user**, and the agent
> runs on your machine with your permissions. Only the users in
> `allowed_users` can make it do anything (by default, only you, the `gh`
> user). It checks who added the `agent` label, who wrote and edited the
> issue, and who wrote each `/pr-daemon` comment, and ignores everyone else.
> The status page shows which GitHub user it's acting as and who is allowed.
> It's built for **private repositories**. On public ones those checks keep
> strangers' issues and comments away from the agent, but read
> [Safety](#safety) first.

---

## Day to day

| You do | pr-daemon does |
|---|---|
| Open an issue and describe the feature. | — |
| Want to talk it through first? Comment on the **issue**: `/pr-daemon how would this fit with the editor?` | An agent reads the issue, the conversation and the code, and replies on the issue. It changes nothing. Each new `/pr-daemon` comment continues the same conversation. When you're happy, add the **`agent`** label: the build gets the conversation too, so what you agreed is what it builds. Once the issue has a PR, the same comment revises that PR instead. |
| Add the **`agent`** label. | Within a minute: labels it `agent:working` and comments with the branch. |
| Wait. Watch at http://localhost:7377 if you like. | Builds, tests, opens a PR, reviews it, and labels the issue `agent:in-review`. |
| Open the **Preview** link in the PR and try it. | Keeps the stack running and restarts it if it stops. |
| Watch your own CI run on the PR, as usual. | If a check fails, an agent fixes it and pushes, up to twice per PR. If it's still red after that, it says so on the PR and stops. |
| Keep merging other work into `main`. | If the PR stops merging cleanly, it merges `main` in and an agent resolves the conflicts. It pushes only once your check passes, and marks anything uncertain **needs your review**. Risky conflicts are left for you, with a comment saying why. |
| Say in the issue "do it the way `your-org/other-repo` does". | Reads that repository — any one you can read — from a read-only clone kept outside the branch. Nothing to configure. |
| Want changes? Comment on the PR: `/pr-daemon make the button blue` (or start it with 😈 / 👿 instead). | Makes the changes, pushes, and comments with a summary and new screenshots. |
| Have a PR already (yours or a teammate's in this repo)? Add the **`agent`** label to the **PR**. | Starts that branch's stack, comments with the preview link, runs your `check` and has an agent fix it until it passes, then reviews the PR. Everything below applies from then on. |
| Merge (or close) the PR. | Stops the stack, removes the worktree, and deletes the branch on GitHub. |
| Changed your mind? Remove the **`agent`** label. | Stops any agent working on it, closes its PR, stops the stack, removes the worktree, and deletes the branch. |

- **Out of budget?** The issue is labelled **`agent:paused`**. It resumes by
  itself when the budget window frees up, with the agent picking up where it
  stopped.
- **Stuck?** The issue is labelled **`agent:failed`** with the reason in a
  comment. Press **Retry** on the status page. Or remove the `agent` label
  (which cleans everything up) and add it again to start from scratch.
- Only **you** can trigger builds and `/pr-daemon` (or the people you list in
  `allowed_users`). pr-daemon checks who added the label and who wrote the
  issue, and everything it does on GitHub is done as you. An issue someone
  else wrote is refused with a comment: open your own issue that says the
  same thing, and label that.

### Labelling a PR that already exists

The `agent` label works on a pull request too, whoever opened it. The branch
gets the full treatment:

1. **The stack, on its public preview URL.** A worktree, your `up` command with
   the same environment a build gets, and so the same
   `https://<branch>.<domain>` — plus a host for each service the stack
   declares — with the same health probes and automatic restart. pr-daemon
   comments with the address as soon as it is up, before anything else.
2. **Driven green.** It runs your `check`. If that fails, an agent fixes the
   cause (never the check: it is told not to delete or weaken tests, not to
   refactor, and not to revert your work), commits, and pr-daemon pushes —
   up to `agent.max_attempts` rounds, as a build gets. It comments with what
   it changed. If it can't get there, it says so on the PR and leaves the rest
   to you.
3. **Reviewed** by a fresh agent that sees only the PR, the code, and that
   running preview.

After that the PR is watched like any other: `/pr-daemon` comments revise it,
a red CI run gets a fix, and a base branch that has moved on is merged in.

The one thing it never does is write a feature: the code is already in the PR.
If you want the review without the fixing, set `check = ""` for that repo (or
leave the `pr-daemon-check` recipe out) — then nothing but the review touches
the branch.

It is **your** branch, so:

- the branch is never deleted and the PR is never closed, not even when you
  take the label off — that only shuts the preview down;
- nothing is ever force-pushed: fixes and merges are ordinary commits on top,
  and a push that would clobber work you pushed meanwhile just fails;
- the PR's own description is left alone: the preview link comes as a comment.

Two things it won't take on, each said on the PR: a branch **from a fork**
(pr-daemon needs a branch in the repository itself, to make a worktree from and
push fixes back to), and a PR whose **title or body** was written by somebody
outside `allowed_users` — the same rule as for issues, because that text is
what the reviewing agent is given. The diff is agent input too, so this is for
repositories whose writers you trust; see [Safety](#safety).

---

## Setup (about 10 minutes)

### 1. Install the tools

You need Node 23.6 or newer, `git`, `gh`, `just`, `docker`, and Claude Code
(`claude`).

```bash
brew install node git gh just     # macOS; use your package manager on Linux (gh ≥ 2.73)
brew install terminal-notifier    # macOS: desktop notifications you can click (Linux uses notify-send)
npm install -g @anthropic-ai/claude-code
gh auth login                     # pr-daemon acts as you, through gh
claude                            # log in once, then exit
```

**On a Mac you reach over SSH**, or if agents fail with *"OAuth session
expired and could not be refreshed"*, give pr-daemon its own Claude login
instead. Claude keeps its login in the macOS Keychain, and an SSH session
can't reach it, so logging in over SSH never fixes the service. A token
from `claude setup-token` lasts a year and works for both:

```bash
claude setup-token                                 # prints a token; over SSH it gives you a URL to open
(umask 077; read -rs T; echo "$T" > ~/.pr-daemon/claude-token)   # paste it, then Enter
```

pr-daemon reads that file before every agent run, so there's nothing to
restart, and `pr-daemon doctor` says which login it used.

### 2. Get pr-daemon

```bash
git clone https://github.com/dionjwa/pr-daemon ~/pr-daemon
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
| `down` | Stop this branch's stack and delete its data. On a restart `PR_DAEMON_KEEP_DATA=1` is set: keep the data then. |

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

**API keys the stack needs** (an OpenAI key, say) go in one file per repo,
outside every checkout:

```bash
mkdir -p ~/.pr-daemon/secrets && chmod 700 ~/.pr-daemon/secrets
$EDITOR ~/.pr-daemon/secrets/your-org__your-repo.env   # OPENAI_API_KEY=sk-...
chmod 600 ~/.pr-daemon/secrets/your-org__your-repo.env
```

`up` gets that file's path as `PR_DAEMON_SECRETS` and reads the keys it needs
from it ([the setup page](docs/setup.md) has the snippet). pr-daemon never
reads the values itself.

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

To shut it down: `pr-daemon stop`, or the **Shut down** button on the status
page (it asks twice). Preview stacks keep running on their local ports; Caddy
stops with it. `uninstall-service` is the one that stops it coming back at
login.

---

## When a PR conflicts with `main`

Other work lands on `main` while a PR waits for you. When GitHub says the PR
no longer merges cleanly, pr-daemon merges `main` into the branch. It never
rebases or force-pushes, so your review comments stay where they were.

1. **No conflicts?** It commits the merge, runs your check, and pushes. No
   agent, no tokens.
2. **Conflicts?** First it decides whether they're safe to hand to an agent.
   They go to **you** instead when:
   - more than `merge.max_files` files conflict
   - a binary file conflicts (only one side can be kept)
   - a file under `.github/workflows/` conflicts, unless the repo sets
     `workflows = true` (then the agent may resolve it, and the merge is
     flagged **needs your review**)
   - a conflict is in one of your `merge.human_paths`
   - this PR has already used its `merge.max_rounds`
3. Otherwise an agent (the one that built the PR, when its session is still
   around) resolves them. It's told to keep both sides' intent, and it writes
   a report: one section per file, a confidence level, and anything it wants
   a person to check.
4. pr-daemon checks the result itself before it commits the merge: it must
   still be the same merge, with no conflict markers left. Then your check
   must pass. A failing check gets the usual fix rounds, and if it still
   fails, **nothing is pushed**.
5. It pushes and comments with the files, the report and a link to the merge
   commit. If the agent wasn't confident or flagged something, or a file was
   deleted on one side, or it changed files outside the conflicts, the
   comment starts with **Needs your review before merging** and you get a
   desktop notification.

When it hands a merge to you, the PR is left exactly as it was, the issue is
labelled `agent:failed`, and the comment says why and how to do it yourself.
You can also reply `/pr-daemon <how to resolve it>` to have the agent try
again with your guidance. The status page's **Merge** column shows each PR's
state at a glance.

## How it works, as state machines

**http://localhost:7377/docs** draws the lifecycle: what the `agent` label
starts on an issue and on a PR (and what each one gets), what watches the PR
while it waits for you, what one job does, and what one preview stack does.
It's the quickest way to see where something is stuck.

## The status page

http://localhost:7377. It's only reachable from your own machine.

- **Needs you** (at the top): one line each time the agent stops and the next
  move is yours — a PR is ready (after its review, and any automatic revise),
  a revise or CI fix was pushed, a merge needs you, a job failed, or a job
  paused until you press Resume. The same notice goes to your desktop
  (`notify = true`) and, if you turn it on with the 🔔 button, to the browser.
  The tab title shows the unread count. The **Setup** tab checks what's
  needed for notifications on this machine and can send a test one. Beside
  the config editor, a checkbox for each kind of notice turns it off or on
  (saved in the config file as `notify_on`).
- **Token budget** (one row at the very top): tokens used in the current
  window, the limit, and when it frees up.
- **Who** and **how to use** are on the **Setup** tab: the GitHub user
  pr-daemon acts as (your `gh` login), the users allowed to trigger work, and
  what the label and `/pr-daemon` comments do.
- **Work:** every job (build, review, revise, ci, merge, teardown, restart) with its
  state, tokens and the reason it's waiting. Click a row to watch the agent
  live. Buttons: **Cancel**, **Resume** (continue where it stopped) and
  **Retry** (start over).
- **Issues and PRs** (at the top): everything pr-daemon is working on, one row
  each, with its app copy's health dot and its CI state. A labelled issue with
  no stack yet (its build is queued, or failed before the stack came up) is
  listed too, as **no stack**. Click a row for every address it has — the public URL, the
  local one behind it, each backend service, the worktree and the commit its
  checks are about. The dot has these states:
  **up** (the address people open answers with the app),
  **degraded** (the app is running here, but its preview URL doesn't serve it —
  usually DNS, the proxy, or the Host the app is given, and the row says which),
  **down** (the app isn't answering at all; it's restarted automatically, the same way as the Restart button),
  and **stopped** (you pressed Tear down).
  Nothing is stopped on a timer: a stack and its row go away when its PR or issue closes,
  or when the label comes off.
  Buttons: **Restart** (runs `down`, then `up`, so the stack picks up a changed
  environment such as a new API key; its data goes too unless `down` honours
  `PR_DAEMON_KEEP_DATA`), **Tear down** (runs `down` to free the machine; the
  row, worktree, branch and PR stay, nothing automatic acts on it, and Restart
  brings it back. A `/pr-daemon` comment on it brings it back too).
- **Events:** what happened, newest first.
- **Pause:** stops new jobs from starting. Running ones finish.
- **Config:** edit the config file in place, with TOML colouring. It's checked
  before saving, so a typo can't break anything. The **All options** tab beside
  it lists every setting, its default and what it does.

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

**Check the routing before any preview exists:** open
`https://pr-daemon.preview.example.com/proxy-check`. Caddy answers it itself with
"pr-daemon: the preview proxy is working." If that loads, DNS, the port
forwards and certificates all work, and any remaining problem is in the
preview's own stack. `just doctor` checks the same address.

**pr-daemon's part:**
- It runs **Caddy**: the `caddy` binary if it's installed (`brew install caddy`), otherwise a Docker container. You can force either with `proxy = "binary"` or `proxy = "docker"`.
- It keeps Caddy's routes equal to the running stacks: a new branch gets a route, and a torn-down one loses it.
- It gets an HTTPS certificate per branch host from Let's Encrypt automatically.
- If Caddy dies it's restarted. When pr-daemon stops, Caddy stops with it, so the preview URLs are down for a few seconds across a restart. (Preview stacks themselves keep running.) If pr-daemon is killed outright, the Caddy that's still running is adopted on the next start.

**With a domain, the public URL is the only one that's used.** The agent
tests there, screenshots come from there, and the PR's **Preview** link points
there. The local URL is just what Caddy forwards to.

**Your app has to be wired for its public address,** and so does every backend
its browser code calls. Browsers block a public page from calling local
addresses (`localhost`, or names like `local.auth.local.nhost.run` that resolve
to 127.0.0.1), so each of those backends gets a public host too:
`https://<branch>--<service>.<domain>`. `pr-daemon-up` declares them by
printing `PR_DAEMON_ROUTE <service> <local-url>` lines, and receives:

| Variable | Example |
|---|---|
| `PR_DAEMON_PUBLIC_URL` | `https://94-my-new-feature.preview.example.com` |
| `PR_DAEMON_PUBLIC_HOST` | `94-my-new-feature.preview.example.com` |
| `PR_DAEMON_SERVICE_URL_TEMPLATE` | `https://94-my-new-feature--{service}.preview.example.com` |

Use them for auth redirect URLs, CORS origins, cookie domains, and every
backend URL the browser uses. All are empty when no domain is set. The
[project setup doc](docs/setup.md#public-preview-urls) has the full checklist.

### The status page from anywhere (optional)

`https://pr-daemon.preview.example.com` can serve the status page, behind a
login. Anyone with that login can edit the config, and its commands run on
this machine, so use a long password you use nowhere else.

```bash
caddy hash-password          # type the password twice; it prints a hash starting $2a$
```

Then add both lines under `[preview]` (in the Config tab, or
`~/.pr-daemon/config.toml`):

```toml
page_user = "you"
page_password_hash = "$2a$14$...the hash it printed..."
```

It applies within seconds, no restart. `just doctor` checks that the page asks
for the login. To take it offline again, delete the two lines.

### One wildcard certificate (recommended)

By default each host gets its own Let's Encrypt certificate. That means a wait
of a few seconds for each new host, a limit of 50 a week per registered domain
(a branch with four services uses five), an hour-long lockout for a host after
5 failed attempts, and every branch name published in the public certificate
logs. If your DNS is on Cloudflare, use one wildcard certificate for
`*.<domain>` instead:

1. Create an API token at dash.cloudflare.com → My Profile → API Tokens, with
   **Zone → DNS → Edit** on just your zone.
2. Save it where pr-daemon reads it (or set `CLOUDFLARE_API_TOKEN` in its
   environment instead):

   ```bash
   (umask 077; pbpaste > ~/.pr-daemon/cloudflare-token)   # or paste it in with an editor
   ```

3. Give Caddy the Cloudflare module (Docker mode builds its own image instead):

   ```bash
   caddy add-package github.com/caddy-dns/cloudflare   # again after each caddy upgrade
   ```

4. Set it in the config:

   ```toml
   [preview]
   dns = "cloudflare"
   ```

5. Run `just doctor`. It checks the token, the zone and the module.

Caddy then proves control of the domain with a DNS record, so port 80 is no
longer needed for certificates. pr-daemon hands the token only to Caddy: it
isn't written to Caddy's config file or passed to agents or project commands.

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
| `allowed_users` | `[]` (only you) | Who may trigger builds and `/pr-daemon`, and whose issues and PR comments the agent may read |
| `concurrency` | `1` | Agent runs at the same time |
| `poll` | `60s` | How often to check GitHub |
| `agent.max_attempts` | `3` | Build → check → fix rounds before giving up |
| `agent.auto_revise` | `true` | The builder answers the reviewer once, automatically |
| `stacks.auto_restart` | `true` | Restart preview stacks that stop answering |
| `checks.watch` | `true` | Read each open PR's checks (your own CI) and show them |
| `checks.fix` | `true` | Put an agent on a failing check |
| `checks.max_rounds` | `2` | Automatic fix rounds per PR before it stops and says so |
| `merge.fix` | `true` | Merge the base in when a PR conflicts with it, with an agent resolving the conflicts |
| `merge.behind` | `false` | Also merge when the base only moved on (no agent): for repos that require up-to-date branches |
| `merge.catch_up` | `true` | When a PR is idle and merges cleanly but is behind its base, merge the base in, run the check and push. It doesn't wait for CI, and a red PR that's behind gets the base merged in before an agent tries to fix CI |
| `merge.max_rounds` | `2` | Agent conflict-resolution rounds per PR before it stops and says so |
| `merge.max_files` / `merge.human_paths` | `15` / `[]` | Conflicts bigger than this, or in these paths (globs), always go to you |
| `preview.domain` | unset | Public preview URLs `https://<branch>.<domain>` (pr-daemon runs Caddy) |
| `preview.proxy` | `auto` | `auto` / `binary` / `docker` / `off` |
| `preview.tls` | `auto` | `auto` (Let's Encrypt) / `internal` (testing) / `off` (plain http) |
| `[[repos]] up / down / check` | `just pr-daemon-up` / `-down` / `-check` | Override for projects without `just` |
| `[[repos]] proxy_host` | `public` | Host header the app sees through the preview proxy: `public` or `upstream` |
| `[[repos]] workflows` | `false` | Agents may edit `.github/workflows/` in this repo, each change flagged for your review. See [Letting agents edit workflows](#letting-agents-edit-workflows) |

## Commands

```bash
pr-daemon serve                      # the process (install-service runs this for you)
pr-daemon status                     # running, queued and paused jobs, and stacks
pr-daemon doctor                     # check tools, logins, config
pr-daemon run build your-org/repo 42 # one job now, in this terminal (build|adopt|review|revise|discuss|ci|merge|teardown|restart)
pr-daemon ref your-org/other-repo    # read-only clone of another repo, for an agent to look at (run it in a worktree)
pr-daemon stop                       # shut it down (stops the service too, if one is installed)
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
  claude-token                      optional: the Claude login agents use (claude setup-token)
  gh-tokens/<owner>                 optional: the GitHub login pr-daemon and its agents use for that owner's repos
  gh-token                          optional: the same, for owners without their own file
  pr-daemon.db                       jobs, token ledger, stacks, events (SQLite)
  pr-daemon.log                      the service's log
  repos/<org>__<repo>/              a cached clone
  worktrees/<org>__<repo>/42-…/     the branch the agent works in (the stack runs from here)
  out/<org>__<repo>/42-…/           prompts, agent logs (*.jsonl), PR text, screenshots
  refs/<org>__<repo>/42-…/          read-only clones of other repos the agent was asked to look at
  secrets/<org>__<repo>.env         optional: the repo's dev API keys; up gets the path as PR_DAEMON_SECRETS
  caddy/                            the generated Caddy config, its log, and certificates (binary mode)
```

These are ordinary files and ordinary git checkouts: open a worktree, read it,
run `git log` in it. `just where` prints the list with the branches checked out
right now, the status page shows each stack's and each job's worktree, and
`<org>__<repo>` is just `owner/name` with the slash replaced (a slash can't be
a directory name). Leave them where they are, though — `down` runs from the
worktree before pr-daemon removes it.

## Safety

pr-daemon is a tool for **your own** repositories. Read this before you point
it at one.

- **It acts as your GitHub user.** It has no bot account or GitHub App of its
  own: it uses your `gh` login, so its branches, pushes, PRs, reviews and
  comments all show up as you. It **never merges**: you do. (It can't approve
  its own PR either, so the review is posted as a comment.)
- **Only allowed users can direct it.** By default that's only you (the `gh`
  user). List others in `allowed_users` (GitHub logins, any case). The status
  page shows who it's acting as and who is allowed. Everything the agent is
  told to do has to come from one of them:

  | What | Checked | If someone else |
  |---|---|---|
  | The `agent` label | who added it | ignored (shown as `ignored` on the status page) |
  | The issue's title and body | who wrote it, everyone who edited the body, everyone who renamed it: when the label is added, and again each time a build starts or resumes | refused, with a comment on the issue saying who and why |
  | A labelled PR's title and body | the same, when the label is added and again when it is taken on | refused, with a comment on the PR saying who and why |
  | A `/pr-daemon` comment | who wrote it | ignored |
  | The PR conversation given to a revision | each comment's and review's author | left out of the prompt (the event log says how many) |
  | The issue conversation given to a discussion or a build | each comment's author (the issue's own text is checked as for a build) | left out of the prompt; refused, with a comment, if the issue text is someone else's |
  | A PR's commits (labelled, or pr-daemon's own) | every commit's author and committer, each time a job starts on the PR: someone can push to a branch at any time | refused, with a comment on the PR saying which commits and who |

  Your own `gh` user's words always count as trusted, because pr-daemon's
  PR descriptions and reviews are posted as you.

  An issue from someone else is refused even if you add the label. To build
  it, open a new issue in your own words and label that, or add the person
  to `allowed_users`.
- **The agent has your access.** It runs Claude Code with permission prompts
  off, as your user, on your machine. It can run any command, read your files,
  and use your `gh` and git logins, so it could push to or comment on any repo
  you can. The prompts tell it not to; nothing technically stops it. Run
  pr-daemon as a dedicated user, or in a VM, if the machine holds anything you
  care about. At the least, give it a GitHub login limited to the repos you
  watch: a fine-grained token per owner in `~/.pr-daemon/gh-tokens/` (see
  [below](#letting-agents-edit-workflows)) replaces your `gh` login for
  pr-daemon, its agents and your project's commands.
- **What it reads is an instruction,** so the checks above decide what reaches
  the agent. pr-daemon hands the agent the issue and the filtered PR
  conversation itself, and the prompts tell it not to fetch comments on its
  own. That last part is a prompt, not a guarantee: the agent has `gh`, so it
  *could* read other issues and comments, and the project's own files (code,
  READMEs, dependencies) reach it too. **Labelling a PR** adds that PR's diff
  to the list: the reviewing agent reads it, and `up` runs the branch's code on
  your machine. Label one the way you'd check out and run the branch yourself. On a **private repository** everyone
  who can write any of that is someone you already trust, which is why it's
  the recommended setup. On a public one the checks keep strangers' issues and
  comments out of the prompts; review what you merge as you would any
  contributor's code.
- **Another repository you name is read, never written.** An issue can say
  "do it like `your-org/other-repo`", and the agent clones that repo
  **read-only** (shallow, pushing disabled, its git hooks off) into
  `~/.pr-daemon/refs/…`, outside the branch it's building. There's nothing to
  configure, so the limit is your `gh` login's own access: anything it can read,
  an issue can point the agent at. That's another reason to give the pr-daemon
  user a login scoped to the repos you watch. What the agent reads there is
  information, the same rule the prompts apply to issues and comments.
- **Workflow files are held back unless a repo allows them.** A workflow runs
  with the repo's secrets, so an agent that can edit one can hand itself those
  secrets. By default an agent's change to `.github/workflows/` is taken out
  before the push and posted on the PR for you to apply. A repo with
  `workflows = true` gets it pushed instead, flagged **needs your review**; see
  the next section.
- **Nothing from the internet connects to pr-daemon itself:** it only polls
  GitHub. The status page listens on 127.0.0.1 only and refuses requests from
  other websites. With a preview domain set, Caddy serves **only the preview
  stacks**, so anyone with a branch's URL can reach that preview, which runs
  unreviewed code on your machine. Treat previews as public, or put access
  control in the app.
- **Secrets:** the optional `claude-token` goes only to the agents. The
  optional `gh-tokens/<owner>` go to everything pr-daemon starts for that owner's repos (`gh`, git, agents
  and your project's commands), since that is what limits them. The optional
  Cloudflare token is passed to Caddy only, never to agents or project
  commands.

### Letting agents edit workflows

For a repo whose CI agents should be able to fix, or features that need a
workflow change. Do all three steps: the first two let it happen, the third
limits what a bad workflow change could reach.

1. **A GitHub login for pr-daemon alone, with workflow access to just your
   repos.** A fine-grained token belongs to **one** account or organization,
   so make one per owner in your config (e.g. one for `your-org`, one for your
   personal account). On GitHub: Settings → Developer settings →
   Fine-grained tokens → Generate new token. Resource owner: that org or you;
   Repository access: *Only select repositories*, that owner's repos in your
   config; Repository permissions: **Contents**, **Pull requests**,
   **Issues** and **Workflows** read and write; **Commit statuses**,
   **Actions** and (if listed) **Checks** read. Without Checks, pr-daemon
   reads your GitHub Actions jobs instead, but can't see checks from other
   apps (e.g. GitGuardian). An org may have to allow
   fine-grained tokens and approve yours (org Settings → Personal access
   tokens). Then, on the pr-daemon machine, save each one under its owner's
   name:

   ```bash
   mkdir -p ~/.pr-daemon/gh-tokens
   (umask 077; read -rs T; echo "$T" > ~/.pr-daemon/gh-tokens/your-org)    # paste the org's token, then Enter
   (umask 077; read -rs T; echo "$T" > ~/.pr-daemon/gh-tokens/your-login)  # paste your personal one, then Enter
   just restart
   just doctor        # "you can push to your-org/…, through ~/.pr-daemon/gh-tokens/your-org"
   ```

   From then on pr-daemon, its agents and your project's commands act through
   the token of the repo's owner, so an agent can't reach any other repo. That
   includes `pr-daemon ref`: an issue can still point the agent at any public
   repo, but a private one has to be on that token's list. A repo whose owner
   has no file uses `~/.pr-daemon/gh-token` if you made one, and otherwise
   your own `gh` login. Keep your own `gh` login without the `workflow` scope
   (`gh auth status` lists the scopes; `gh auth refresh -h github.com
   --remove-scopes workflow` takes it off), so the tokens are the only logins
   on the machine that can change a workflow. (Using your own login with
   `gh auth refresh -h github.com -s workflow` works too, but then it covers
   every repo you can reach.) To stop using a token, delete its file and
   `just restart`.

2. **Opt the repo in,** under its block in `config.toml` (or the Config tab):

   ```toml
   [[repos]]
   name = "your-org/your-repo"
   workflows = true
   ```

   Agents are then told they may edit workflows (narrowly: no new secrets,
   permissions, `pull_request_target` or self-hosted runners unless the task
   asks for it). Every pushed workflow change gets a `> [!WARNING]` comment
   on the PR with the diff and the commands to undo it, a warning on the
   status page, and a desktop notice. A refused push falls back to holding
   the change back. Set `workflows = false` again to stop.

3. **Keep the secrets that matter away from branches.** A workflow edited on
   a branch runs on that branch, with every repository secret. Put deploy
   and production secrets in an **Environment** instead (repo Settings →
   Environments → New environment, add the secrets there, and under
   *Deployment branches* allow only `main`, or add yourself as a required
   reviewer), and reference it with `environment:` in the job that deploys.
   A branch's workflow then can't read them, whoever wrote it.

See [PLAN.md](PLAN.md) for the design and roadmap.
