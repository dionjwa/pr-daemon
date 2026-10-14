#!/usr/bin/env bash
# Runner "job started" hook: refuse any job that isn't an allowed workflow.
#
# Labels only route jobs; they don't restrict them. Any workflow in a repo
# that can see this runner could ask for `runs-on: [pr-demon]`. This hook runs
# on YOUR machine before every job, so it is the real gate.
#
# Allowed workflows: PR_DEMON_ALLOWED_WORKFLOWS in the runner's .env,
# comma-separated glob patterns matched against GITHUB_WORKFLOW_REF
# (owner/repo/.github/workflows/file.yml@ref).
set -euo pipefail
allowed="${PR_DEMON_ALLOWED_WORKFLOWS:-*/.github/workflows/pr-demon.yml@refs/heads/main}"
ref="${GITHUB_WORKFLOW_REF:-}"
IFS=',' read -ra patterns <<<"$allowed"
for p in "${patterns[@]}"; do
  p="${p#"${p%%[![:space:]]*}"}"; p="${p%"${p##*[![:space:]]}"}"
  # shellcheck disable=SC2053  # glob match is the point
  [[ -n "$p" && "$ref" == $p ]] && { echo "pr-demon runner: allowed $ref"; exit 0; }
done
echo "::error::pr-demon runner refuses workflow '$ref'. Allowed: $allowed"
exit 1
