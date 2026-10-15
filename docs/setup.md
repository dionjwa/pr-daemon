# Set up a project for pr-daemon

pr-daemon turns a labelled GitHub issue into a pull request, on one machine.
This page is the contract a project has to meet. It's written to be handed to a
coding agent: everything it needs is here.

Status page: {{STATUS_URL}} · config file: {{CONFIG_PATH}}

## What pr-daemon runs

Three command lines, per repository:

    up       REQUIRED   start this branch's whole stack, and print its local URL
             on this machine: {{UP}}
    down     REQUIRED   stop this branch's stack and delete its data
             on this machine: {{DOWN}}
    check    optional   must pass before a PR opens; "" trusts the agent's testing
             on this machine: {{CHECK}}

**They can be any shell command.** Each one is run as

    bash -lc "<the command>"

from the root of the branch's worktree. These are all equally valid:

    up = "npm run preview:up"
    up = "docker compose up -d --wait && echo http://localhost:8080"
    up = "make preview && ./scripts/print-url.sh"
    up = "./scripts/preview-up.sh"
    up = "just pr-daemon-up"
    up = "pnpm vite preview --port 8080 >/dev/null 2>&1 & sleep 2; echo http://localhost:8080"

The defaults name `just` recipes only because that's the convention in the
projects this was written for. There is nothing special about `just`, with one
small exception: if a command is
exactly `just <recipe>` and that recipe doesn't exist in the project,
pr-daemon treats it as "not configured" instead of as a failure. Any other
command that exits non-zero is a failure.

## The rules each command must follow

### `up` — start this branch's stack

1. **Print the local URL as the last line of stdout**, on its own:
   `http://localhost:8080` or `https://app.localhost`. That line is how
   pr-daemon learns the URL — it takes the last line that is nothing but a URL.
   Send everything else to stderr if that's easier.
2. **Return only when the app answers.** Start services in the background, then
   wait (`--wait`, a `curl` loop, whatever fits). Don't exit before the app is
   up, and don't block forever in the foreground. Timeout: 30 minutes.
3. **Be idempotent.** If the stack is already running, print the URL and exit 0.
4. **Isolate per branch.** Two branches' stacks run at the same time, so derive
   ports, container names, volumes and database names from the branch name
   (`git rev-parse --abbrev-ref HEAD`). Nothing may collide.
5. **Never open a browser**, never prompt, never wait on a TTY. There isn't one.

### `down` — stop it and delete its data

Stop this branch's services and delete its volumes and data. It runs when the
PR or the issue is closed, and before the worktree is removed. It must be safe
to run when nothing is up.

With docker compose, use `down -v --remove-orphans` so volumes **and the
project's networks** go with it. Docker's default address pool only fits about
31 bridge networks, and each preview takes one or two: leftovers eventually
make every `up` fail with "all predefined address pools have been fully
subnetted". pr-daemon removes the networks it watched your `up` create, but
only the ones nothing is attached to — a `down` that cleans up after itself is
still the first line of defence.

### `check` — the definition of done (optional)

Whatever must be green before a pull request is opened: type check, lint, unit
tests. pr-daemon runs it after the agent says it's finished, and on failure
resumes the same agent session to fix it (up to {{MAX_ATTEMPTS}} rounds on
this machine). Keep it fast and deterministic. Leave it out, or set `check = ""`, to trust the agent.

## Public preview URLs

Preview domain on this machine: {{PREVIEW}}

When one is set, every branch is also served at `https://<branch>.<domain>`,
and `up` receives two more environment variables. The app should use them as
its public origin (auth redirects, CORS, cookies, printed links):

    PR_DAEMON_PUBLIC_URL    e.g. https://42-dark-mode.preview.example.com
    PR_DAEMON_PUBLIC_HOST   e.g. 42-dark-mode.preview.example.com

They are empty when no domain is set. Keep printing the **local** URL as the
last line either way: pr-daemon maps the public host to it.

If the app rejects unknown Host headers, set `proxy_host = "upstream"` for the
repo and it will see its local host instead of the public one.

## Where to put the commands

Either way works:

1. **Add the commands to the project** under the default names
   (`pr-daemon-up`, `pr-daemon-down`, `pr-daemon-check` recipes, scripts, npm
   scripts — anything the defaults above can invoke). Then the config needs
   nothing but the repo name.
2. **Point the config at what the project already has** — no changes to the
   project at all:

        [[repos]]
        name = "owner/repo"
        up = "docker compose up -d --wait && echo http://localhost:3000"
        down = "docker compose down -v --remove-orphans"
        check = "npm test"

   The double brackets make it a list: repeat the whole `[[repos]]` block for
   each repository.

## The environment the commands run in

- **Working directory:** the branch's worktree — an ordinary checkout with the
  branch already checked out. Everything pr-daemon keeps lives under
  `{{HOME}}`, with the repository written `<org>__<repo>` (a double
  underscore, because a slash can't be a directory name):

        {{REPOS}}/<org>__<repo>
            the cached clone, fetched once and reused
        {{WORKTREES}}/<org>__<repo>/<branch>
            the checkout the agent works in; your up/down/check commands run here
        {{OUT}}/<org>__<repo>/<branch>
            prompts, the agent's own logs (*.jsonl), PR text, screenshots

  Nothing stops you opening those directories, reading them, or running git in
  them — they are normal checkouts. Leave them where they are, though: the
  `down` command runs from the worktree before it's removed.
- A normal developer environment: your login shell's PATH, Docker, etc. `CI` is
  **not** set, deliberately.
- No TTY, no interactive prompts, no browser.

## Test it before you call it done

From a real branch of the project, on the machine that runs pr-daemon:

    git switch -c 1-test-preview
    bash -lc '<the up command>'          # returns, prints the URL last
    curl -sI "$(bash -lc '<the up command>' | tail -1)"   # 2xx/3xx, and proves it's idempotent
    bash -lc '<the check command>'       # exits 0
    bash -lc '<the down command>'        # stops everything, deletes its data

Then start a second branch's stack at the same time and confirm both answer.

## Checklist

- [ ] `up` prints the local URL as the very last line of stdout
- [ ] `up` returns once the app answers, and is idempotent
- [ ] ports, container names and volumes derive from the branch name
- [ ] `down` deletes the branch's data, networks included, and is safe when nothing runs
- [ ] `check` (if any) is green on a clean checkout
- [ ] nothing prompts, and nothing opens a browser
- [ ] `PR_DAEMON_PUBLIC_URL` is used as the public origin, if previews are on
- [ ] the repo is listed in {{CONFIG_PATH}} as a `[[repos]]` block
- [ ] `pr-daemon doctor` is all ✓

Then label an issue **{{LABEL}}** and watch {{STATUS_URL}}. Ask for changes with
a pull request comment starting `{{COMMAND}}`. A human merges; pr-daemon never
does.
