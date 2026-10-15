# pr-demon

**Label an issue. Get a pull request.**

You write a feature request as a GitHub issue and add the `agent` label. An
AI agent running on **your own machine** then:

1. creates a branch, e.g. `42-dark-mode-toggle`
2. starts a full copy of your app for that branch
3. builds the feature and its tests, and keeps going until your checks pass
4. opens a pull request with a description, screenshots, and a link to the
   running app
5. asks a second agent, which sees only the PR, to review it

**You** test it, then approve and merge it. Merging or closing the PR shuts the
app copy down and cleans up.

```
 you                    pr-demon (on your machine)                         you
 ───                    ──────────────────────────                         ───
 issue #42  ──label──▶  branch 42-dark-mode-toggle
                        start stack ─▶ agent builds ─▶ checks pass?
                                          ▲                │ no
                                          └── fix ◀────────┘
                                                           │ yes
                        open PR (+ screenshots, preview link)
                        fresh agent reviews the PR ───────────────────▶  test & approve
                                                                         merge / close
                        stop stack, delete worktree  ◀──────────────────────────┘
```

---

## How you use it, day to day

| You do | pr-demon does |
|---|---|
| Open an issue and describe the feature. | — |
| Add the label **`agent`**. | Labels the issue `agent:working` and comments with the branch and a log link. |
| Wait. | Builds, tests, opens a PR, reviews it, and labels the issue `agent:in-review`. |
| Open the **Preview** link in the PR and try it. | Keeps the stack running. |
| Want changes? Comment on the PR: `/demon make the button blue`. | Makes the changes, pushes, and comments with a summary and new screenshots. |
| Approve and merge (or close). | Stops the stack and removes the worktree. |

If it gets stuck, the issue is labelled **`agent:failed`** with the reason
in a comment. Fix the issue text and re-add the `agent` label to try again.

---

## Setup

You do this once per machine (steps 1–4), and then once per project (steps 5–7).

### 1. Install the tools on the machine that will run the agent

You need `git`, `gh`, `jq`, `perl`, `just`, `docker` and Claude Code (`claude`).

```bash
brew install git gh jq just      # macOS; use your package manager on Linux
npm install -g @anthropic-ai/claude-code
gh auth login
claude                           # log in once, then exit
```

### 2. Get pr-demon

```bash
git clone https://github.com/metapages/pr-demon ~/pr-demon
```

### 3. Install the pr-demon runner

```bash
~/pr-demon/runner/install.sh  your-org/your-repo     # one repo  (you must be repo admin)
# or
~/pr-demon/runner/install.sh  your-org               # every repo in an org (org admin)
```

This installs a **separate** GitHub Actions runner in
`~/actions-runner-pr-demon` and starts it as a service. It is locked down:

- Its only label is `pr-demon`. It doesn't have `self-hosted`, so your
  existing CI never runs on it, and the agent never blocks your CI.
- It **refuses every workflow except `pr-demon.yml` on `main`**. The rule is
  `PR_DEMON_ALLOWED_WORKFLOWS` in `~/actions-runner-pr-demon/.env`.

Check it's online: repo (or org) → **Settings → Actions → Runners**.

### 4. Give the runner a Claude login

The runner runs as a background service, and it **can't use the `claude`
login from your terminal**. That login lives in a keychain the service can't
read. Make a long-lived token and put it on the machine:

```bash
claude setup-token                       # opens a browser, prints a token
echo 'CLAUDE_CODE_OAUTH_TOKEN=<paste token>' >> ~/actions-runner-pr-demon/.env
cd ~/actions-runner-pr-demon && ./svc.sh stop && ./svc.sh start
```

The token stays on your machine, and only the pr-demon runner can see it.
Prefer a repo secret? Add it as `CLAUDE_CODE_OAUTH_TOKEN` instead; the
example workflow passes it through.

### 5. Teach your project four commands

Add these recipes to your project's `justfile` (see
[`examples/justfile`](examples/justfile)):

| Recipe | What it must do |
|---|---|
| `pr-demon-up` | Start **this branch's** whole stack in the background and return once it's answering. If it's already running, return straight away. Don't open a browser. |
| `pr-demon-url` | Print the URL a person should open to try this branch. |
| `pr-demon-down` | Stop this branch's stack and delete its data. |
| `pr-demon-check` | The "done" bar: checks that must pass before a PR is opened. |

Run them yourself on a branch to make sure they work:

```bash
just pr-demon-up && just pr-demon-url && just pr-demon-check && just pr-demon-down
```

Two branches' stacks must be able to run at the same time, so derive ports and
container names from the branch name.

`pr-demon-up` must keep the stack running after it returns. Start it with
`nohup … &` or `docker compose up -d`. pr-demon clears the runner's
process-tracking variable, so the job ending doesn't kill it.

> Not using `just`? Set `PR_DEMON_UP`, `PR_DEMON_URL`, `PR_DEMON_DOWN` and
> `PR_DEMON_CHECK` to any shell commands in the runner's `.env`.

### 6. Add the workflow

Copy [`examples/pr-demon.yml`](examples/pr-demon.yml) to
`.github/workflows/pr-demon.yml` in your project and **merge it to `main`**.
GitHub only runs issue-triggered workflows from the default branch.

### 7. Let Actions open PRs

Repo → **Settings → Actions → General → Workflow permissions**:

- choose **Read and write permissions**
- tick **Allow GitHub Actions to create and approve pull requests**

You're done. Open an issue and add the `agent` label.

> **Try it before merging the workflow.** Run the whole flow from a terminal
> against a branch that has the recipes: `PR_DEMON_REPO=org/repo
> PR_DEMON_BASE=my-branch ~/pr-demon/bin/pr-demon build 42`. That's exactly
> what the workflow runs. It uses your own `gh` login, so your normal CI also
> runs on the agent's pushes.

---

## Optional

**Make your CI run on the agent's pushes.** GitHub doesn't trigger workflows
from pushes made with the built-in `github.token`. Use a GitHub App token
(`actions/create-github-app-token`) for `github-token` if you want your normal
CI checks to run on pr-demon's PRs.

**Settings** (environment variables in the runner's `.env`):

| Variable | Default | Meaning |
|---|---|---|
| `PR_DEMON_LABEL` | `agent` | The issue label that starts a build. If you change it, also change `'agent'` in your `pr-demon.yml` |
| `PR_DEMON_HOME` | `~/.pr-demon` | Where clones, worktrees and logs live |
| `PR_DEMON_MAX_ATTEMPTS` | `3` | Build → check → fix rounds before giving up |
| `PR_DEMON_MAX_TURNS` | `200` | Turns per agent run |
| `PR_DEMON_AUTO_REVISE` | `1` | Let the builder answer the reviewer once, automatically |
| `PR_DEMON_MODEL` | Claude's default | Model for the agent |

---

## Running it by hand

Everything the workflow does, you can run in a terminal:

```bash
export PR_DEMON_REPO=your-org/your-repo
~/pr-demon/bin/pr-demon build 42        # issue → PR
~/pr-demon/bin/pr-demon review 57       # review PR #57
~/pr-demon/bin/pr-demon revise 57 "make the button blue"
~/pr-demon/bin/pr-demon status          # running stacks and their URLs
~/pr-demon/bin/pr-demon teardown 42     # stop issue #42's stack
~/pr-demon/bin/pr-demon reap            # stop every stack whose issue is closed
```

Or from GitHub: **Actions → pr-demon → Run workflow**.

## Where things are on the machine

```
~/.pr-demon/
  repos/<org>__<repo>/                  a cached clone
  worktrees/<org>__<repo>/42-dark-mode/ the branch the agent works in (and the stack runs from)
  out/<org>__<repo>/42-dark-mode/       prompts, agent logs (*.jsonl), PR text, screenshots
```

## Safety

- The agent has full control of the runner machine. Run the runner as a
  dedicated user (or in a VM) if that machine holds anything you care about.
- pr-demon **never merges**. A human approves every PR.
- The agent can't change your workflows: `github.token` isn't allowed to push
  changes to `.github/workflows/`.
- Only repo owners, members and collaborators can trigger `/demon`.

See [PLAN.md](PLAN.md) for the design and roadmap.
