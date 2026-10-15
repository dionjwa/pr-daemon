# pr-demon journal

A running log of what was built, decided and learned, newest first. For how the
system works see CLAUDE.md; for the roadmap see PLAN.md.

---

## 2026-10-15: public preview URLs, cleanup, handoff docs

**Done**
- Removed the last traces of the GitHub Actions prototype from the code:
  `cleanEnv` now drops only `CI` and the markers of an enclosing Claude Code
  session, and the job table is renamed `RUNNERS` → `JOBS`. In framejs.app,
  removed the unused `pr-demon-url` recipe.
- **Public preview URLs.** With `[preview] domain` set, each branch is served
  at `https://<branch>.<domain>`:
  - pr-demon supervises **Caddy**, either the binary or the `caddy:2` Docker
    container (`proxy = auto | binary | docker | off`).
  - Routes are rebuilt from the stacks table every 5s and loaded through
    Caddy's admin API when they change.
  - TLS: Let's Encrypt per branch host (`auto`), Caddy's own CA (`internal`,
    for testing), or `off`.
  - `pr-demon-up` receives `PR_DEMON_PUBLIC_URL` and `PR_DEMON_PUBLIC_HOST`.
    A per-repo `proxy_host = public | upstream` controls the Host header the
    app sees.
  - The status page shows the proxy state and public links, and `doctor`
    checks the proxy and DNS.
- Verified with `*.pr-demon.localhost` on ports 8080/8443:
  - routing works in Docker and binary mode (healthz and the home page of
    #99's stack returned 200 through Caddy)
  - switching modes while running
  - adopting an already-running Caddy after a pr-demon restart
  - relaunching on port changes
  - stopping when the domain is unset
- Bugs fixed while testing:
  - port changes didn't relaunch Caddy
  - the first Docker start timed out during the image pull
  - Caddy's admin API refused Node's `fetch` (undici sends
    `Sec-Fetch-Mode: cors`), fixed by sending an allowed `Origin`
- Wrote **CLAUDE.md** (goals, owner decisions, code map, gotchas, dogfood
  state) so a future agent session in this repo has the full context.
- Tests: 10 unit tests (amounts, durations, templates, config, budget, host
  labels, public URLs, Caddy config). CI is green.

**Known quirks**
- On non-standard test ports, Caddy's HTTP → HTTPS redirect drops the port.
  With real ports 80/443 this doesn't happen.
- Previews are public to anyone with the URL. There's no access control yet.

---

## 2026-10-14 → 15: rewrite as a single host process

**Decision:** replace the GitHub Actions + self-hosted runner design with
**one Node/TypeScript process** on the host. The owner's choices:
- it acts as their own GitHub user
- only users who are allowed (by default, only the owner) can trigger it by
  adding the label
- the budget is tokens per subscription window in human amounts
- state lives in SQLite
- a web page shows status and edits the TOML config

**Done**
- `pr-demon serve`, made up of:
  - a GitHub poller: label events (with a check of who added the label) and
    `/demon` comments
  - a SQLite job queue
  - a scheduler with a budget gate
  - an agent supervisor: live token accounting, stall detection, pause and
    resume of Claude sessions, rate-limit handling
  - stack health checks with automatic restarts
  - automatic teardown when the PR or issue closes
- Status page on `localhost:7377` with Cancel, Resume, Retry, Pause,
  Restart/Tear down for stacks, an event log, and a raw TOML config editor
  that validates before saving.
- `install-service`: a launchd agent (or systemd user unit). `claude` works
  headless under launchd with HOME and PATH set, so no OAuth token is needed.
- **Dogfood: framejs.app issue #99 → PR #100** (`/api/healthz`). It
  exercised:
  - build → check → fix → PR → fresh review (`VERDICT: ok`)
  - resuming after a failed push (the same Claude session continued)
  - a `/demon` revise that was paused mid-run by the per-issue cap, then
    resumed in the same session after the cap was raised
  - preview stacks surviving a pr-demon restart
- Teardown verified manually on #96.

**Learned**
- stream-json repeats usage once per content block, so dedupe by message id.
- Pushes that touch `.github/workflows` are refused because the gh login has
  no `workflow` scope. That's a good guard, and pr-demon now explains it when
  it happens.
- `gh issue edit --remove-label` fails the whole edit if any one label
  doesn't exist, so status labels are set through the REST API instead.
- Node crashes on unhandled promise rejections, so error handlers that call
  GitHub must never throw.

---

## 2026-10-13 → 14: first prototype (GitHub Actions + self-hosted runner), since removed

**Built** (bash, now deleted):
- a composite action plus an example workflow
- a dedicated runner with only the `pr-demon` label
- a job-started hook that refused any workflow except `pr-demon.yml` on `main`
- prompts for build, fix, review and revise

**Dogfood: framejs.app issue #96 → PR #97** (site footer):
- branch, stack, build and tests, then a PR with 4 screenshots
- an independent review that caught a committed tool cache
- an automatic revise that fixed it

The run cost about 2.8M tokens, around 94% of them cache reads.

**Why it was dropped**
- Too much setup: a runner, a hook, a workflow per repo, repo settings, and a
  Claude token, because the runner service couldn't use the keychain login.
- `GITHUB_TOKEN` quirks: its pushes don't trigger CI, and the PRs it opens
  don't trigger other workflows.
- No live control over token use.

---

## Next steps

**Needs the owner**
1. **Real preview domain:**
   - set `[preview] domain` (and optionally `email`) in the Config tab
   - point a wildcard DNS record `*.<domain>` at this machine
   - forward ports 80 and 443 to it
   - run `pr-demon doctor` to confirm
2. **Merge `pr-demon-setup` → `main` in framejs.app** (the `pr-demon-*`
   recipes), then delete `base = "pr-demon-setup"` from the config.
3. **Close or merge the trial PRs #97 and #100.** Closing one also verifies
   automatic teardown on PR close, end to end.
4. **Remove the old runner** `mini2-pr-demon` (`~/actions-runner-pr-demon`).
   It's registered and idle, but no longer used.
5. **Decide when to make `metapages/pr-demon` public.** It's written to be
   safe for that.

**Engineering**
- framejs.app public previews (good first `agent` issue):
  - its `pr-demon-up` should use `PR_DEMON_PUBLIC_URL` for app origins
  - its browser code calls nhost on `local.<svc>.local.nhost.run:<port>`,
    which also needs public routes
- Optional access control on previews (basic auth or a shared secret).
- A wildcard certificate through a DNS challenge, instead of one Let's Encrypt
  certificate per branch.
- Show the spend per PR in its description, and per-repo budgets.
- A form view of the config next to the raw TOML.
- Several machines coordinating through GitHub labels.
