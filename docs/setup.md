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
   Send everything else to stderr if that's easier. With a preview domain, also
   print a `PR_DAEMON_ROUTE` line for each backend the browser calls (see
   [Public preview URLs](#public-preview-urls)).
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

This is the *inner* gate. Your repository's own CI is the outer one: pr-daemon
pushes as you, so your normal workflows run on every push, and it watches their
result on the pull request. A failing check gets an agent that reads the
failure (and the failed job's logs, where GitHub has them), fixes the cause and
pushes again — up to {{CI_ROUNDS}} time(s) per PR on this machine (0 means it
only reports), then it says so on the PR and stops. Nothing extra is needed in
your project for that; two things make it work better:

- keep the CI failure readable (a clear failing step beats one long log)
- remember pr-daemon **cannot push changes under `.github/workflows/`** (its
  GitHub login has no `workflow` scope, on purpose), so a failure that can only
  be fixed in a workflow file is reported, not fixed

## Public preview URLs

Preview domain on this machine: {{PREVIEW}}

When one is set, each branch is served publicly, and **that is the only
address its stack is used at**: by the agent, in screenshots, and by reviewers
from the PR's Preview link. A stack is wired for one origin, so when a domain
is set, wire it for the public one. The local URL you print becomes the
address pr-daemon's proxy forwards to, and nobody opens it directly.

### Every address the browser calls must be public too

Browsers block a page on a public origin from calling loopback or private
addresses (Chrome's Local Network Access). The error looks like this:

    Access to fetch at 'https://local.auth.local.nhost.run:11536/…' from origin
    'https://42-dark-mode.preview.example.com' has been blocked by CORS policy:
    Permission was denied for this request to access the `loopback` address space.

So the app's own URL isn't enough. Any backend that **browser code** calls
directly (auth, GraphQL, storage, an API on a different port, websockets) needs
a public address as well. pr-daemon gives every branch a family of hosts:

    https://<branch>.<domain>              the app (the last URL line `up` prints)
    https://<branch>--<service>.<domain>   each service `up` declares

To declare a service, `up` prints one line per service to stdout, anywhere
before the final URL:

    PR_DAEMON_ROUTE <service> <local-url>

`<service>` is 1–12 lowercase letters or digits. For example:

    PR_DAEMON_ROUTE auth https://local.auth.local.nhost.run:11536
    PR_DAEMON_ROUTE graphql https://local.graphql.local.nhost.run:11536
    https://framejs-app.localhost:13536

pr-daemon forwards `https://<branch>--auth.<domain>` to
`https://local.auth.local.nhost.run:11536`, and gets HTTPS certificates for
every one of these hosts. Requests reach the service with its **local** Host
header (gateways such as Traefik, or nhost's local proxy, route on it), and its
self-signed certificate is accepted. Calls made between services on the server
side can keep using local addresses. Only what the browser calls needs a public
route.

### What `up` receives

    PR_DAEMON_PUBLIC_URL            https://42-dark-mode.preview.example.com
    PR_DAEMON_PUBLIC_HOST           42-dark-mode.preview.example.com
    PR_DAEMON_SERVICE_URL_TEMPLATE  https://42-dark-mode--{service}.preview.example.com

Put a service name in place of `{service}` to get its public URL, e.g. in bash:

    AUTH_URL="${PR_DAEMON_SERVICE_URL_TEMPLATE/\{service\}/auth}"

All three are empty when no domain is set. Then run exactly as you do locally.

### Wiring checklist for public mode

When `PR_DAEMON_PUBLIC_URL` is set, `up` must configure the stack so that:

- the app's own origin is `PR_DAEMON_PUBLIC_URL`: links it prints, auth
  redirect and callback URLs, cookie domains, `allowedHosts` and the like
- browser code calls each backend through its public service URL, never
  `localhost`, `127.0.0.1`, `*.localhost` or a hostname that resolves to them
  (`*.local.nhost.run` does). Pass the URLs in at build or start time, since
  most frameworks bake them into the browser bundle
- each of those backends allows `PR_DAEMON_PUBLIC_URL` as a CORS origin and as
  an allowed redirect URL, and builds its own absolute URLs (email links, OAuth
  callbacks) from its public service URL
- `up` prints a `PR_DAEMON_ROUTE` line for each of those backends

If the app rejects unknown Host headers, set `proxy_host = "upstream"` for the
repo and the app will see its local host instead of the public one. Services
always see their local host.

Test it from outside: open `PR_DAEMON_PUBLIC_URL` in a browser, use the
feature that talks to each backend (sign in, load data), and check the
console. There should be no CORS, Local Network Access or mixed-content
errors, and no request to a local address in the network tab.

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
- [ ] if previews are on: the app uses `PR_DAEMON_PUBLIC_URL` as its origin, every
      backend the browser calls is declared with `PR_DAEMON_ROUTE` and reached at
      its public service URL, and the public URL works in a browser with a clean console
- [ ] the repo is listed in {{CONFIG_PATH}} as a `[[repos]]` block
- [ ] `pr-daemon doctor` is all ✓

Then label an issue **{{LABEL}}** and watch {{STATUS_URL}}. Ask for changes with
a pull request comment starting `{{COMMAND}}`. A human merges; pr-daemon never
does.
