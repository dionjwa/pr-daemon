# Credentials: what pr-daemon holds, and the scope each one needs

Every login pr-daemon uses, what it is for, the smallest scope that still
works, what somebody could do with it, and how to replace it. Keep all of
these in **one directory** (`~/.pr-daemon/` on a host install, the
credentials mount in a container) so backing them up and rotating them is one
job. Nothing here is ever written by pr-daemon, which is why the container
mounts that directory read-only.

Two things to hold on to while reading:

- **Agents get some of these.** The GitHub token and the Claude token are in
  the environment of every `claude` pr-daemon starts, because the agent has to
  push and to be logged in. A repo's dev secrets are handed to the project's
  own commands. So "what can this token do" is also "what can a prompt-injected
  agent do". That is the reason for the narrow scopes below.
- **The issue body and the PR comments are agent input,** whoever added the
  label. That is why pr-daemon is recommended for private repositories (the
  README's Safety section is the contract).

## The list

| Credential | File | Who uses it | Scope it needs | What it can do if it leaks |
|---|---|---|---|---|
| **GitHub, per owner** | `gh-tokens/<owner>` | `gh`, `git push` (through `gh auth git-credential`), agents, the project's commands | A **fine-grained** PAT whose resource owner is `<owner>`, limited to **only the repositories in your config**. Permissions below. | Read and write code, PRs, issues and labels — on those repositories only |
| **GitHub, fallback** | `gh-token` | the same, for owners with no file of their own | A classic token needs `repo` (and `workflow` if a repo sets `workflows = true`) | **Every repository you can reach.** Use fine-grained tokens per owner instead |
| **GitHub, none** | — | the same | `gh`'s own login (`gh auth login`) | Everything your GitHub account can do. Convenient to start with, widest blast radius |
| **Claude** | `claude-token` | every `claude` run (`CLAUDE_CODE_OAUTH_TOKEN`) | A token from `claude setup-token`. There is no narrower scope | Spend your Claude subscription or API credit, as you |
| **Cloudflare (optional)** | `cloudflare-token` | Caddy, for the `*.<domain>` wildcard certificate (DNS-01) | **Zone → DNS → Edit**, on that one zone. Nothing else | Change DNS records in that zone |
| **Status page login (optional)** | `config.toml`: `page_user`, `page_password_hash` | Caddy, when the page is served at `https://pr-daemon.<domain>` | A bcrypt hash from `caddy hash-password` | The page edits `config.toml`, whose commands run on this machine: treat it as **shell access**. Never serve the page publicly without it |
| **A repo's dev secrets** | `secrets/<org>__<repo>.env` | the project's `up` / `down` / `check`, and agents, as the **path** `$PR_DAEMON_SECRETS` | Whatever that project's dev stack needs. Development keys only — never production | Whatever those third-party dev accounts allow |
| **The Docker socket** | `/var/run/docker.sock` | preview stacks, the preview proxy | Full Docker API | **Equivalent to root on the host.** See docs/container.md |

pr-daemon reads the token files on **every use**, so replacing one takes
effect without a restart. `chmod 600` each of them; `pr-daemon doctor` says so
if one is readable by anyone else.

## The fine-grained GitHub token, permission by permission

One token per **resource owner** (an account or an organisation), because
that is how GitHub scopes them — hence one file per owner. Create it at
**Settings → Developer settings → Personal access tokens → Fine-grained
tokens**, select **only the repositories** in your config, and set:

| Permission | Level | What needs it |
|---|---|---|
| Metadata | Read | mandatory, implied by the rest |
| Contents | Read and write | clone, push, delete the branch pr-daemon made, `compare` (is this PR behind its base), `update-branch` |
| Pull requests | Read and write | open a PR, edit its body, post the review comment, labels on an adopted PR |
| Issues | Read and write | read the issue and its events, the `/pr-daemon` comments, post replies, the `agent:*` status labels |
| Commit statuses | Read | the older CI verdicts (`commits/<sha>/status`) |
| Checks | Read | check runs (`commits/<sha>/check-runs`) |
| Actions | Read | the failing jobs and their logs, when a check run is not readable |
| Workflows | Read and write | **only** for a repo with `workflows = true`. Leave it out and an agent's `.github/workflows/` edit is held back for you instead |

Two things GitHub itself makes awkward, both handled in code:

- **Checks may 403** ("Resource not accessible by personal access token") even
  with the box ticked, because some token pages don't offer it. `gh.checks()`
  then reads the Actions jobs of the commit's workflow runs instead, which is
  the same list minus other apps' checks.
- **A fine-grained token reports no scopes**, so pr-daemon can't tell whether
  it may push workflow files; it assumes yes and explains the refusal if
  GitHub says no.

Leave your own `gh` login **without** the `workflow` scope. Then a push that
touches a workflow file is refused by GitHub rather than silently allowed,
which is the behaviour the hold-back logic is built around.

## Rotating one

| Credential | How |
|---|---|
| GitHub | Create the new token, write it to the same file (`chmod 600`), delete the old one on GitHub. Nothing to restart |
| Claude | `claude setup-token`, write it to `claude-token` |
| Cloudflare | New token with Zone → DNS → Edit, write it to `cloudflare-token`. Caddy is relaunched automatically (the stored fingerprint changes) |
| Status page | `caddy hash-password`, put the hash in `config.toml` |
| Dev secrets | Edit the env file, then Restart that branch's stack so its `up` reads it again |

## What is *not* a credential, and shouldn't be treated as one

- **`allowed_users`** decides who may trigger work. It is not a secret, but it
  is the control that keeps a stranger's label or comment from starting an
  agent — and so is `gh.provenance()`, which checks who *wrote* the issue, and
  `trustCode()`, which checks who wrote every commit on a PR.
- **The database** (`pr-daemon.db`) holds job history, the token ledger and the
  stack rows. No tokens.
- **The agent logs** (`out/.../ *.jsonl`) hold prompts, tool calls and results.
  No tokens — but they do hold whatever the agent read, which can include a
  repo's source and the contents of files it opened.
