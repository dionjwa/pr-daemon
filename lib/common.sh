# shellcheck shell=bash disable=SC2034  # globals here are read by bin/pr-demon
# Shared helpers for bin/pr-demon. Sourced, never executed.

# ---------- config (all overridable via env) ----------
PR_DEMON_HOME="${PR_DEMON_HOME:-$HOME/.pr-demon}"
PR_DEMON_LABEL="${PR_DEMON_LABEL:-agent}"             # the label you put on an issue
PR_DEMON_BASE="${PR_DEMON_BASE:-}"                     # base branch; default = repo default branch
PR_DEMON_MAX_TURNS="${PR_DEMON_MAX_TURNS:-200}"        # per agent run
PR_DEMON_MAX_ATTEMPTS="${PR_DEMON_MAX_ATTEMPTS:-3}"    # build → check → fix rounds
PR_DEMON_AUTO_REVISE="${PR_DEMON_AUTO_REVISE:-1}"      # let the builder answer the reviewer once
PR_DEMON_MODEL="${PR_DEMON_MODEL:-}"                   # empty = claude's default
PR_DEMON_ASSETS_BRANCH="${PR_DEMON_ASSETS_BRANCH:-pr-demon-assets}"
# The project contract: four just recipes (see README "Project setup").
PR_DEMON_UP="${PR_DEMON_UP:-just pr-demon-up}"
PR_DEMON_DOWN="${PR_DEMON_DOWN:-just pr-demon-down}"
PR_DEMON_URL="${PR_DEMON_URL:-just pr-demon-url}"
PR_DEMON_CHECK="${PR_DEMON_CHECK:-just pr-demon-check}"

LABEL_WORKING="${PR_DEMON_LABEL}:working"
LABEL_REVIEW="${PR_DEMON_LABEL}:in-review"
LABEL_FAILED="${PR_DEMON_LABEL}:failed"

# Empty secrets arrive as "" from workflow inputs; a set-but-empty token would
# shadow the runner user's own `claude` login, so drop them.
[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || unset CLAUDE_CODE_OAUTH_TOKEN
[ -n "${ANTHROPIC_API_KEY:-}" ] || unset ANTHROPIC_API_KEY

log()  { printf '\033[1m[pr-demon]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[pr-demon] error:\033[0m %s\n' "$*" >&2; exit 1; }
need() { for c in "$@"; do command -v "$c" >/dev/null || die "missing required command: $c"; done; }

# ---------- repo identity + paths ----------
# REPO is owner/name. Under Actions it comes from GITHUB_REPOSITORY; locally
# pass --repo or set PR_DEMON_REPO.
init_repo() {
  REPO="${PR_DEMON_REPO:-${GITHUB_REPOSITORY:-}}"
  [ -n "$REPO" ] || die "no repo: set PR_DEMON_REPO=owner/name (or run inside GitHub Actions)"
  local key="${REPO//\//__}"
  REPO_DIR="$PR_DEMON_HOME/repos/$key"
  WT_ROOT="$PR_DEMON_HOME/worktrees/$key"
  OUT_ROOT="$PR_DEMON_HOME/out/$key"
  mkdir -p "$WT_ROOT" "$OUT_ROOT"
  if [ -z "$PR_DEMON_BASE" ]; then
    PR_DEMON_BASE="$(gh repo view "$REPO" --json defaultBranchRef --jq .defaultBranchRef.name)"
  fi
}

run_url() {
  if [ -n "${GITHUB_RUN_ID:-}" ]; then
    echo "${GITHUB_SERVER_URL:-https://github.com}/$REPO/actions/runs/$GITHUB_RUN_ID"
  fi
}

# ---------- the agent's environment ----------
# The agent and the stack run as if a developer were at a terminal: no
# GITHUB_*/RUNNER_*/CI variables. Two reasons:
#  1. Projects branch on them (e.g. "under Actions, name the stack ci-…"), so
#     the preview stack would differ from what `just dev` gives you locally.
#  2. The runner kills every process carrying this job's RUNNER_TRACKING_ID
#     when the job ends. The preview stack must outlive the job.
# GH_TOKEN is kept so `gh` and git (via gh's credential helper) still work.
clean_env() {
  local v
  for v in $(compgen -e); do
    case "$v" in
      GITHUB_*|RUNNER_*|ACTIONS_*|INPUT_*|CI|STATE_*) unset "$v" ;;
    esac
  done
}

# run_in <dir> <cmd...> — run a command in a worktree with the clean env.
run_in() {
  local dir="$1"; shift
  ( cd "$dir" && clean_env && bash -c "$*" )
}

# ---------- git ----------
# One cached clone per repo; every branch is a worktree off it. Auth goes
# through `gh auth git-credential`, which reads GH_TOKEN at call time, so no
# token is ever written to disk.
ensure_clone() {
  if [ ! -d "$REPO_DIR/.git" ]; then
    log "cloning $REPO → $REPO_DIR"
    mkdir -p "$(dirname "$REPO_DIR")"
    git -c credential.helper= -c 'credential.helper=!gh auth git-credential' \
      clone -q "https://github.com/$REPO.git" "$REPO_DIR"
  fi
  git -C "$REPO_DIR" config --replace-all credential.https://github.com.helper ''
  git -C "$REPO_DIR" config --add credential.https://github.com.helper '!gh auth git-credential'
  git -C "$REPO_DIR" config user.name  "${PR_DEMON_GIT_NAME:-pr-demon[bot]}"
  git -C "$REPO_DIR" config user.email "${PR_DEMON_GIT_EMAIL:-pr-demon@users.noreply.github.com}"
  git -C "$REPO_DIR" fetch -q --prune origin
  git -C "$REPO_DIR" worktree prune
}

# Remote branch for an issue: any branch named "<number>-…".
find_branch() {
  local n="$1"
  git -C "$REPO_DIR" for-each-ref --format='%(refname:lstrip=3)' "refs/remotes/origin/$n-*" | head -1
}

# Local worktree for an issue, if one exists.
find_worktree() {
  local n="$1" d
  for d in "$WT_ROOT/$n"-*; do [ -d "$d" ] && { echo "$d"; return 0; }; done
  return 0
}

slugify() {
  tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' \
    | cut -d- -f1-5 | cut -c1-40 | sed -E 's/-+$//'
}

# "<n>-<very-short-summary>". Ask a small model for the summary; fall back to
# the issue title so a hiccup never blocks the run.
make_branch_name() {
  local n="$1" title="$2" slug=""
  slug="$( (claude -p --model haiku --max-turns 1 \
    "Reply with ONLY a 2-4 word lowercase kebab-case summary of this GitHub issue title, nothing else: $title" \
    2>/dev/null || true) | head -1 | slugify)"
  [ -n "$slug" ] || slug="$(printf '%s' "$title" | slugify)"
  [ -n "$slug" ] || slug="issue"
  echo "$n-$slug"
}

# ensure_worktree <issue-number> [title] → sets BRANCH and WT
ensure_worktree() {
  local n="$1" title="${2:-}"
  BRANCH="$(find_branch "$n")"
  WT="$(find_worktree "$n")"
  if [ -n "$WT" ]; then
    BRANCH="$(git -C "$WT" rev-parse --abbrev-ref HEAD)"
    log "reusing worktree $WT ($BRANCH)"
    git -C "$WT" pull -q --ff-only origin "$BRANCH" 2>/dev/null || true
    return
  fi
  if [ -n "$BRANCH" ]; then
    WT="$WT_ROOT/$BRANCH"
    log "checking out existing branch $BRANCH → $WT"
    git -C "$REPO_DIR" worktree add -q -B "$BRANCH" "$WT" "origin/$BRANCH"
  else
    BRANCH="$(make_branch_name "$n" "$title")"
    WT="$WT_ROOT/$BRANCH"
    log "new branch $BRANCH from origin/$PR_DEMON_BASE → $WT"
    git -C "$REPO_DIR" worktree add -q -b "$BRANCH" "$WT" "origin/$PR_DEMON_BASE"
  fi
}

# ---------- GitHub ----------
ensure_labels() {
  gh label create "$PR_DEMON_LABEL" -R "$REPO" --color 5319e7 --description "An agent builds this issue (pr-demon)" 2>/dev/null || true
  gh label create "$LABEL_WORKING"  -R "$REPO" --color fbca04 --description "pr-demon is working on this" 2>/dev/null || true
  gh label create "$LABEL_REVIEW"   -R "$REPO" --color 0e8a16 --description "pr-demon opened a PR; waiting for a human" 2>/dev/null || true
  gh label create "$LABEL_FAILED"   -R "$REPO" --color d93f0b --description "pr-demon gave up; see the issue comments" 2>/dev/null || true
}

set_status_label() {  # set_status_label <number> <label-or-empty>
  local n="$1" want="$2" l
  for l in "$LABEL_WORKING" "$LABEL_REVIEW" "$LABEL_FAILED"; do
    [ "$l" = "$want" ] || gh issue edit "$n" -R "$REPO" --remove-label "$l" >/dev/null 2>&1 || true
  done
  [ -z "$want" ] || gh issue edit "$n" -R "$REPO" --add-label "$want" >/dev/null 2>&1 || true
}

comment() {  # comment <number> <markdown>
  gh issue comment "$1" -R "$REPO" --body "$2" >/dev/null || log "could not comment on #$1"
}

pr_for_branch() {
  gh pr list -R "$REPO" --head "$1" --state open --json number --jq '.[0].number // empty'
}

# ---------- the agent ----------
# render <template> — replace {{NAME}} with $NAME from the environment.
render() { perl -pe 's/\{\{(\w+)\}\}/exists $ENV{$1} ? $ENV{$1} : ""/ge' "$1"; }

# agent <prompt-file> <log-file> — one headless Claude Code run in $WT.
# Raw stream-json goes to the log; the final message is printed.
agent() {
  local prompt="$1" logf="$2" args=()
  args=(-p "$(cat "$prompt")" --permission-mode bypassPermissions
        --max-turns "$PR_DEMON_MAX_TURNS" --output-format stream-json --verbose)
  [ -z "$PR_DEMON_MODEL" ] || args+=(--model "$PR_DEMON_MODEL")
  log "agent run → $logf"
  ( cd "$WT" && clean_env && claude "${args[@]}" ) > "$logf" 2> "${logf%.jsonl}.stderr" \
    || log "agent exited non-zero (see $logf)"
  jq -rR 'fromjson? | select(.type=="result") | .result // empty' "$logf" 2>/dev/null | tail -40 || true
}

# ---------- stack ----------
stack_up() {  # → sets PREVIEW_URL; returns non-zero (with STACK_ERR) on failure
  log "starting stack: $PR_DEMON_UP"
  local out
  if out="$(run_in "$WT" "$PR_DEMON_UP" 2>&1)"; then
    PREVIEW_URL="$(run_in "$WT" "$PR_DEMON_URL" 2>/dev/null | tail -1)"
    log "stack up: $PREVIEW_URL"
    return 0
  fi
  STACK_ERR="$(printf '%s' "$out" | tail -60)"
  PREVIEW_URL=""
  return 1
}

check() {  # → sets CHECK_OUT; returns the check's exit code
  log "checking: $PR_DEMON_CHECK"
  local rc=0
  CHECK_OUT="$(run_in "$WT" "$PR_DEMON_CHECK" 2>&1)" || rc=$?
  CHECK_OUT="$(printf '%s' "$CHECK_OUT" | tail -80)"
  return $rc
}

# ---------- screenshots ----------
# GitHub has no API to attach images to a PR, so screenshots are committed to
# an orphan branch and linked. In a private repo they still render for anyone
# who can see the PR.
# upload_screenshots <dir> → prints a markdown block (empty if no images)
upload_screenshots() {
  local dir="$1" assets="$PR_DEMON_HOME/assets/${REPO//\//__}" f md="" sha
  compgen -G "$dir/*.png" >/dev/null || return 0
  if [ ! -d "$assets/.git" ]; then
    mkdir -p "$assets"
    git -C "$assets" init -q
    git -C "$assets" remote add origin "https://github.com/$REPO.git"
  fi
  git -C "$assets" config credential.https://github.com.helper '!gh auth git-credential'
  git -C "$assets" config user.name  "${PR_DEMON_GIT_NAME:-pr-demon[bot]}"
  git -C "$assets" config user.email "${PR_DEMON_GIT_EMAIL:-pr-demon@users.noreply.github.com}"
  if git -C "$assets" fetch -q origin "$PR_DEMON_ASSETS_BRANCH" 2>/dev/null; then
    git -C "$assets" checkout -q -B "$PR_DEMON_ASSETS_BRANCH" FETCH_HEAD
  else
    git -C "$assets" checkout -q --orphan "$PR_DEMON_ASSETS_BRANCH" 2>/dev/null || true
  fi
  mkdir -p "$assets/$BRANCH"
  cp "$dir"/*.png "$assets/$BRANCH/"
  git -C "$assets" add "$BRANCH"
  git -C "$assets" commit -q -m "screenshots for $BRANCH" || true
  git -C "$assets" push -q origin "HEAD:$PR_DEMON_ASSETS_BRANCH"
  sha="$(git -C "$assets" rev-parse HEAD)"
  for f in "$dir"/*.png; do
    f="$(basename "$f")"
    md+="**${f%.png}**"$'\n\n'"![${f%.png}](https://github.com/$REPO/blob/$sha/$BRANCH/$f?raw=true)"$'\n\n'
  done
  printf '%s' "$md"
}
