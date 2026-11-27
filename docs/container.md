# pr-daemon in a container

Run the daemon and its agents in a container so that **what an agent can reach
is a list you wrote**, not your whole home directory. Three mounts go in — two
to back up, one not to — plus the Docker socket, and nothing else of the host.

```bash
cp docker/.env.example docker/.env   # set the three paths
just container-build                 # the daemon plus git, gh, just, docker, deno, claude, chromium
just container-up                    # starts now, and whenever Docker starts
just container-doctor                # tools, logins, mounts, and the work-disk path
```

The status page is on `http://localhost:7377` as before, published on the
host's loopback only.

## The mounts

| Mount | Holds | Mode | Back it up? |
|---|---|---|---|
| `$PR_DAEMON_CONFIG_DIR` → `/pr-daemon/config` | `config.toml` | read-write | **yes** — it is small and you wrote it by hand |
| `$PR_DAEMON_CREDENTIALS_DIR` → `/pr-daemon/credentials` | `claude-token`, `gh-token`, `gh-tokens/<owner>`, `cloudflare-token`, `secrets/<org>__<repo>.env` | **read-only** | **yes** — and encrypt the backup |
| `$PR_DAEMON_WORK` → the same path | `repos/`, `worktrees/`, `out/`, `refs/`, `assets/`, `caddy/`, `pr-daemon.db`, `pr-daemon.log` | read-write | **no** — gigabytes, and all of it rebuildable |
| `/var/run/docker.sock` | the host's Docker | read-write | — |

In code these are `CONFIG_HOME`, `CREDENTIALS_HOME` and `WORK_HOME`
(`src/util.ts`), set by `PR_DAEMON_CONFIG_HOME`,
`PR_DAEMON_CREDENTIALS_HOME` and `PR_DAEMON_WORK_HOME`. Each one falls back to
`PR_DAEMON_HOME`, so a host install is still one directory and nothing about it
changed.

**Where to put the three.** Anywhere, with one constraint: the work disk's path
has to be one the host shares with Docker. Two layouts that work:

    ~/.pr-daemon-config   ~/.pr-daemon-credentials   /Volumes/work/pr-daemon
    <this checkout>/.pr-daemon/{config,credentials,work}        # one tree, gitignored

The second keeps everything beside the code, which is easier to sync. `.gitignore`
has `/.pr-daemon/` for exactly that, and `.dockerignore` has `.pr-daemon` —
without that second line every image build would send the whole work disk to
Docker as build context. Either way, keep the *work* directory out of the backup
or the sync: it is the big, rebuildable one, and the other two are the point.

Three decisions worth knowing:

- **Config is a directory, never a mounted `config.toml`.** A save writes
  `config.toml.tmp` and renames it over the real file; renaming onto a
  bind-mounted *file* fails, and the Config tab would break on the first save.
- **Credentials are read-only** because pr-daemon never writes them. An agent
  in this container can read the tokens it is given — that is unavoidable, it
  has to push — but it cannot add a login, replace one, or quietly widen one.
- **The database lives on the work disk, not with the config.** Its rows point
  at worktrees on that disk. Restoring a backed-up database next to a wiped
  work disk would be worse than starting clean: every stack row would name a
  worktree that isn't there.

### Why the work disk is mounted at the same path on both sides

This is the one rule you cannot bend. A preview stack is started by the
project's own `up`, which usually runs `docker compose` — and that talks to the
**host's** Docker through the socket. Every bind mount in that compose file is
resolved by the host, not by this container. So if the worktree is
`/Volumes/work/pr-daemon/worktrees/org__repo/42-thing` on the host and
`/pr-daemon/work/worktrees/...` in here, the stack comes up with **empty
mounts** and nothing says why.

`docker/compose.yaml` therefore mounts it as `${PR_DAEMON_WORK}:${PR_DAEMON_WORK}`.
`pr-daemon doctor` checks it for real: it writes a marker into the work disk and
asks the host's Docker to read it back through the same path from a sibling
container.

### The database belongs to the container alone

`pr-daemon.db` is on the work disk, which is a bind mount — and a bind mount
shares no file locks between the host and the container. Two SQLite connections
therefore cannot see each other: the one on the host finds a write-ahead log
that nobody appears to hold, recovers it, and when it closes it checkpoints and
**deletes** it, while the daemon keeps writing to the inode it still has open.
Those writes are then unreachable. A single `sqlite3` query from the host cost
three job rows while this was being tested, and nothing reported an error.

So: query it **inside** the container. `just db 'select …'` does that for you
whenever one is running, and `openDb()` opens the file read-only on the host
while the daemon's marker (`.daemon-in-a-container`) is fresh, so a stray
`pr-daemon` command on the host can read but never damage it, and `pr-daemon
serve` on the host refuses to start. The daemon touches the marker every 30
seconds; a marker left by a killed container stops counting after 2 minutes. Inside the
container it is an ordinary database on an ordinary mount, and a second process
there sees the daemon's commits as it should.

The log file (`just logs`) is plain text and safe to read from either side.

## What this buys you

Inside the container an agent — or anything a prompt-injected agent runs — can
reach exactly:

- the worktree it is working in, and the rest of the work disk (other
  branches' checkouts, agent logs, the database);
- `config.toml`;
- the credentials in the table above, with the scopes in
  [docs/credentials.md](credentials.md);
- the network, as any process on your machine can;
- the Docker socket (see below).

It **cannot** reach your `~/.ssh`, your cloud CLI logins, your browser
profiles, your other repositories, your password manager, your Documents, or
the machine's launchd/systemd. On a host install it could reach all of them.
That is the whole point of this.

Hardening in `docker/compose.yaml`, beyond the mounts: a non-root user
(uid matched to the work disk's owner), `no-new-privileges`, `cap_drop: ALL`
with only what the entrypoint needs to drop privileges and join the socket's
group, a pids limit, a size-capped log, and `/tmp` in memory.

## The Docker socket, honestly

**Mounting the Docker socket is equivalent to giving this container root on the
host.** Anything that can talk to that socket can start a privileged container
that mounts `/`. No amount of `cap_drop` in this compose file changes that.

It is mounted because the thing pr-daemon exists to do needs it: a project's
preview stack is `docker compose up`, and the preview proxy is a Caddy
container. Pretending otherwise would be security theatre.

What you can actually do about it, in increasing order of effort:

1. **Nothing, deliberately.** The container is still a real improvement: the
   blast radius goes from "everything in the owner's account" to "everything,
   but only if an agent *deliberately* pivots through the Docker API". Most of
   what you are defending against — an agent that wanders out of its worktree,
   a prompt injection that reads `~/.aws/credentials` — is stopped by the
   mounts.
2. **Leave the socket out.** Delete that volume line. Everything works except
   stacks that need Docker and the Docker-mode preview proxy, so it suits a
   project whose `up` is a plain dev server. `doctor` says what is missing.
3. **A socket proxy** (`DOCKER_SOCKET` in `docker/.env` points at it) that
   allowlists API calls. Be clear-eyed: `docker compose` needs containers,
   images, networks, volumes and exec, and a proxy that allows those is close
   to full access again. It mainly buys an audit log and blocks the lazier
   paths.
4. **A Docker daemon of its own** (a nested or rootless daemon used only for
   previews) so preview containers can't see the host's. This is the real fix
   and it is not wired up here: the published ports then live in that daemon's
   namespace, which the preview proxy and the health probes would have to
   follow.

## Networking: "localhost" is not the host any more

Preview stacks are the container's **siblings** and publish their ports on the
host. So inside the container, `http://localhost:5173` is nothing. Four things
follow from that, all of them handled:

- **`PR_DAEMON_LOCAL_HOST=host.docker.internal`** is how the host is reached
  (compose adds the `host-gateway` entry Linux doesn't give you). `viaHost()`
  rewrites a `localhost` URL before an agent is told it.
- **The health probes** use `curl --resolve`, so the request goes to the host
  while the `Host` header and TLS name stay what the URL says. That matters:
  the probes exist to tell "the app is running" from "a person can open it",
  and a rewritten Host would answer a different question.
- **Public preview names** (`https://<branch>.<domain>`) would otherwise leave
  the container, hit public DNS and depend on your router hairpinning back.
  Instead pr-daemon keeps a block in **its own** `/etc/hosts` pointing every
  name a stack answers on at the host gateway, rebuilt from the stacks table
  like the Caddy routes (`src/hosts.ts`). Agents, Playwright and curl then all
  reach the real Caddy. The host's `/etc/hosts` is never touched.
- **Caddy's admin API** is reached by container name over a shared Docker
  network (`PR_DAEMON_DOCKER_NETWORK=pr-daemon`), so its admin port is
  published nowhere at all. Publishing it to `127.0.0.1` on a Linux host would
  not have been reachable through `host-gateway` anyway, and publishing it on
  every interface would put Caddy's admin API on your LAN.

The preview proxy must therefore be **`proxy = "docker"`**: it binds the host's
ports 80/443, which this container doesn't have. `doctor` says so.

### Both modes work, and what each reader gets

| | No `[preview] domain` (local URLs) | With a domain (`https://<branch>.<domain>`) |
|---|---|---|
| **You**, in a browser on the host | `http://localhost:<port>` — the stack's containers publish it on the host, as always. The PR body, the PR comments and the status page all show this address | the public URL. Nothing about this changed: Caddy was already a container binding the host's 80/443 |
| **The agent** (curl, Playwright, screenshots) | `http://host.docker.internal:<port>`, and it is told in the same breath that the address **a person** opens is the `localhost` one, so that is what goes in the PR description | the public URL, resolved by the `/etc/hosts` block to the host gateway → the real Caddy |
| **The health probes** | `--resolve` to the host | both probes `--resolve` to the host, so "degraded" still means what it means |
| **Caddy** | not running | `host.docker.internal:<port>` for each stack, its own network for the status page |

Verified on Docker Desktop: with `domain = "previews.test"` and
`tls = "internal"`, an agent inside the container fetches
`https://pr-daemon.previews.test:8443/proxy-check` from the real Caddy and
`https://4-x.previews.test:8443/` reaches the stack's upstream, while the two
health probes still tell up from degraded.

### Don't use a `.localhost` preview domain in a container

The README's no-domain testing mode (`domain = "pr-daemon.localhost"`) is the
one thing that does **not** work in here, and `/etc/hosts` cannot save it:
**curl and Chrome resolve every `*.localhost` name to loopback themselves**
(RFC 6761) and never consult the hosts file. So an agent opening
`https://4-x.pr-daemon.localhost:8443` reaches *this container*, not Caddy.
Your own browser on the host is fine, and so are pr-daemon's probes (they use
`--resolve`, which does override it) — but the agents, Playwright and the
screenshots are not. `doctor` says so.

Use any other name instead. It does not have to be real or resolvable:
pr-daemon writes the `/etc/hosts` entries inside the container itself, so a
made-up domain is enough to test the whole path.

```toml
[preview]
domain     = "previews.test"   # anything that isn't under .localhost
proxy      = "docker"
tls        = "internal"
http_port  = 8080
https_port = 8443
```

To open those previews in your own browser too, add a line per host to the
machine's own `/etc/hosts` (there is no wildcard in a hosts file):

```bash
sudo sh -c 'echo "127.0.0.1 pr-daemon.previews.test" >> /etc/hosts'
```

With `tls = "internal"` the certificate comes from Caddy's own CA, which
nothing trusts (pr-daemon never installs it), so an agent's `curl` or
Playwright will complain about it — on a host install just the same. That mode
is for checking the routing, not for running agents against. A real domain with
`[preview] dns` set needs none of this.

### The config watch is deaf to edits made outside the container

A bind mount delivers no inotify events for a change made on the host (Docker
Desktop's file sharing drops them), so the directory watch on `config.toml`
never fires for your own editor. pr-daemon therefore **re-reads the file every
5 seconds** as well; it compares the text with what it last applied, so a
change you make in an editor on the host is picked up within a few seconds,
exactly as a save from the Config tab is.

### There is no `gh auth login` in here

gh has no login of its own in the container, and can't get one: the credentials
mount is read-only and nothing in here opens a browser. So every GitHub call
goes through a token file — `gh-tokens/<owner>` for a repo's own owner, which
`asOwner()` selects, and `gh-token` for a call that belongs to no repo.

That last kind matters more than it looks. It is `gh.viewer()`, which is how
pr-daemon learns **who it acts as**, and that answer is also what gives git an
identity — a container starts with no `~/.gitconfig`, and git refuses to commit
without one. Unanswered, the daemon polls, builds and reviews quite happily and
then every agent's first commit fails. So with no `gh-token` file,
`ghTokenFile()` borrows one of the per-owner tokens for that one question: they
are all the same GitHub user. `doctor` names the file it used, and if there is
no token at all it says what to write and where, instead of telling you to run
a command that cannot work in here.

## If your stack isn't Docker

A project whose `up` is `docker compose up` needs nothing special: those
containers are the host's, and they publish their ports there as always.

A project whose `up` starts a **plain dev server** is different. That server
runs *inside this container*, and its port is published nowhere — so your
browser can't open it and Caddy can't proxy to it. (pr-daemon's own health
probe copes: it tries the host first and then the address as given.) Two ways
out:

1. **Publish a range** and have `up` pick its ports from it. There is a
   commented `ports:` line in `docker/compose.yaml` for this; uncomment it, set
   `PR_DAEMON_STACK_PORTS`, and make the project's `up` choose a port in that
   range. Docker publishes each port in a range, so keep it small.
2. **Host networking** (Linux only): `network_mode: host` and no `ports:`.
   Then `localhost` means the host again and nothing needs rewriting — unset
   `PR_DAEMON_LOCAL_HOST` too. On Docker Desktop this is not an option: a
   host-network container's ports are not forwarded to macOS, so the status
   page would be unreachable.

## What the image contains

An agent works in somebody else's repository, so the image carries the tools
those repositories expect: git, `gh` (≥ 2.73), `just`, the Docker CLI with
compose and buildx, Node 24 with npm, Deno, Python 3, build-essential, curl,
jq, sqlite3, rsync, openssh-client, ripgrep, Chromium through Playwright (for a
PR's screenshots), and `claude` itself.

Two extension points, both in `docker/.env`:

```
PR_DAEMON_EXTRA_APT=postgresql-client redis-tools   # Debian packages your repos need
PR_DAEMON_PLAYWRIGHT=false                          # skip Chromium (~400 MB)
```

pr-daemon's own source is **in the image**, not mounted: an agent can write
anywhere it can reach, and pr-daemon's code should not be one of those places.
So picking up a code change is `just container-restart` (build, then up).

## Differences from a host install

| | Host | Container |
|---|---|---|
| Start at boot | `just install-service` (launchd / systemd) | the compose restart policy; `install-service` refuses and says so |
| Desktop notifications | terminal-notifier / notify-send | **none** — they can't leave the container. "Needs you" on the status page, and its browser notifications, are where notices appear |
| `prevent_sleep` | `caffeinate` keeps the Mac awake | no effect in here; keep the **host** awake yourself |
| git identity | your `~/.gitconfig` | `PR_DAEMON_GIT_NAME` / `_EMAIL`, or the gh user's noreply address, written on first start |
| Preview proxy | `caddy` binary or Docker | Docker only |
| Picking up code changes | `just restart` | `just container-restart` |

## Backing it up

```bash
# The two that matter. Encrypt the second one: it is every login pr-daemon has.
tar -czf pr-daemon-config-$(date +%F).tgz -C "$PR_DAEMON_CONFIG_DIR" .
tar -czf pr-daemon-creds-$(date +%F).tgz  -C "$PR_DAEMON_CREDENTIALS_DIR" .
```

The work disk is deliberately not in that list. To rebuild it: start the
container with an empty work directory. Clones are re-fetched, worktrees are
re-created from GitHub, and open PRs are picked back up from their labels. What
is actually lost is job history, the token ledger (so the rolling budget window
starts fresh), old agent logs and Caddy's certificates — which are re-issued
automatically. If your previews use per-host certificates rather than a
wildcard, re-issuing many at once can hit Let's Encrypt's rate limits, which is
one more reason to set `[preview] dns` and get one wildcard instead.
