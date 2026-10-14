# pr-demon: goals and plan

## Goal

Describe a feature in a GitHub issue, add a label, and get back a pull request
that is ready for a human to test and approve:

1. A branch named `<issue>-<very-short-summary>`.
2. A full local stack for that branch, running on a machine you own.
3. An agent that builds the feature, writes tests, and keeps iterating until
   the project's checks pass.
4. A PR with a description, screenshots of any UI changes, and a link to the
   running app.
5. A separate review by a second agent that sees only the PR.
6. A human approves and merges. **pr-demon never merges.**
7. Everything is cleaned up automatically once the PR is merged or closed.

It has to be **portable**. Any project that can start a per-branch stack from
a command can use it, whatever its language or framework.

## Design decisions

| Decision | Why |
|---|---|
| **GitHub Actions is the orchestrator.** There's no separate daemon or poller. | Events, logs, secrets, retries and concurrency come for free. Nothing extra to keep alive. |
| **A dedicated self-hosted runner on your machine** with only the `pr-demon` label. | The stack and agent need your Docker, disk and CPU. A separate runner means your normal CI never queues behind an hour-long agent run. Without the `self-hosted` label, existing `runs-on: self-hosted` jobs can't land on it. |
| **The runner refuses every other workflow** (job-started hook). | Labels route jobs but don't restrict them. The hook runs on your machine and only allows `pr-demon.yml` from the default branch. |
| **One composite action plus one copy-paste workflow per project.** | The project owns its triggers. pr-demon owns the logic. Updating is just bumping a ref. |
| **The project contract is four `just` recipes**: `pr-demon-up`, `pr-demon-url`, `pr-demon-down`, `pr-demon-check`. | This is the only project-specific part. The commands are overridable for projects without `just`. |
| **Each branch gets a git worktree** under `~/.pr-demon/`, and the stack is started detached. | Several issues can be in flight at once, and the stack outlives the job so a human can test it. |
| **The agent runs in a developer-like environment**, with no `GITHUB_*`, `RUNNER_*` or `CI` variables. | The stack behaves exactly like `just dev` on a laptop. The runner also won't kill the stack when the job ends. |
| **Agent = headless Claude Code (`claude -p`).** | It reads the project's CLAUDE.md and skills, so project knowledge lives in the project. |
| **pr-demon decides "done"**, not the agent: it re-runs `pr-demon-check` and loops back with the failure up to 3 times. | Agents claim success too early. The harness verifies. |
| **The reviewer is a fresh `claude -p`** with only the PR number. | No build context leaks in, by construction. It posts a COMMENT review because a bot can't approve its own PR, and that's the point: the human approves. |
| **One automatic revise round** if the reviewer says `VERDICT: changes`. After that, a human drives with `/demon <feedback>` comments on the PR. | Cheap fixes happen without you, and there's no endless agent ping-pong. |
| **Screenshots are committed to an orphan `pr-demon-assets` branch** and linked from the PR. | GitHub has no API for attaching images to PRs. |
| **Cleanup has three triggers**: PR closed, issue closed, and a nightly reaper. | Missed events don't leave stacks running for ever. |
| **Labels show state**: `pr-demon` → `pr-demon:working` → `pr-demon:in-review` (or `pr-demon:failed`). | You can see what's happening from the issue list. |
| **The repo is public-safe**: no secrets, hostnames or paths in it. Its own CI runs only on GitHub-hosted runners. | Secrets live in the calling repo or on the runner machine. Callers pin a SHA. |

## Security model

- The agent runs with full permissions **on your machine**. The runner should
  ideally run as a dedicated OS user (later: a VM).
- `github.token` can't push changes to `.github/workflows/`, so the agent
  can't rewrite its own triggers. Keep it that way: don't hand pr-demon a
  token with the `workflows` permission.
- Teardown uses `pull_request_target`, so it always runs the default branch's
  copy of `pr-demon.yml`, never a PR's edited copy.
- Only `OWNER`, `MEMBER` and `COLLABORATOR` can trigger `/demon`, and only
  people with triage rights can add labels.

## Plan

### Phase 1: works on one machine, one repo (this draft)

- [x] `bin/pr-demon` with build, review, revise, teardown, reap and status
- [x] prompts: build, fix, review, revise
- [x] composite `action.yml` and an example caller workflow
- [x] runner install with only the `pr-demon` label and the job-started hook
- [x] dogfood on `metapages/framejs.app`: contract recipes, runner, a real issue → PR
      (issue #96 → PR #97: built, checked, screenshots, review, auto-revise)
- [x] runner refuses non-allowed workflows (verified with a throwaway workflow)
- [x] fixes from the run: tracked-only leftover commits (the reviewer caught a
      committed tool cache), agent stderr kept out of the JSON log, `set -e`
      traps, scripts safe to update mid-run
- [ ] runner service needs `CLAUDE_CODE_OAUTH_TOKEN` (keychain login isn't
      visible to launchd): human step, documented in the README
- [ ] merge `pr-demon.yml` to the default branch and run one issue fully through Actions
- [ ] teardown on PR close, verified end to end

### Phase 2: reachable from the internet

- Caddy as a launchd/systemd service with `import previews/*.caddy`.
  `pr-demon-up` writes `previews/<branch>.caddy` and reloads, and
  `pr-demon-down` removes it.
- Either one pfSense forward (443 → Caddy, wildcard DNS-01 cert) or a
  Cloudflare Tunnel (no router changes).
- Projects need configurable public origins (auth redirect URLs, CORS,
  cookies) for the preview hostname.

### Phase 3: polish

- Optional GitHub App token so the project's own CI runs on the agent's pushes.
- Cost and time caps per issue. Post the agent's token usage to the PR.
- Tag releases (`v1`). Callers pin a SHA.
- Several runners or machines, with a stack-per-machine registry.
