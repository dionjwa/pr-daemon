#!/usr/bin/env bash
# Install a dedicated, locked-down GitHub Actions runner for pr-demon.
#
#   runner/install.sh owner/repo     runner for one repository  (needs repo admin)
#   runner/install.sh my-org         runner for a whole org     (needs org admin)
#
# What you get:
#   - its own directory (default ~/actions-runner-pr-demon), separate from any
#     runner you already have, so your normal CI never queues behind the agent
#   - ONLY the label `pr-demon` (no `self-hosted`), so existing
#     `runs-on: self-hosted` jobs can never land on it
#   - the job-started hook, so it refuses every workflow except pr-demon.yml
#   - installed as a service that starts at login/boot
set -euo pipefail

target="${1:?usage: install.sh <owner/repo | org>}"
dir="${PR_DEMON_RUNNER_DIR:-$HOME/actions-runner-pr-demon}"
name="${PR_DEMON_RUNNER_NAME:-$(hostname -s)-pr-demon}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$target" == */* ]]; then api="repos/$target"; else api="orgs/$target"; fi

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) plat=osx-arm64 ;; Darwin-x86_64) plat=osx-x64 ;;
  Linux-x86_64) plat=linux-x64 ;; Linux-aarch64) plat=linux-arm64 ;;
  *) echo "unsupported platform $(uname -sm)"; exit 1 ;;
esac

if [ ! -x "$dir/config.sh" ]; then
  ver="$(gh api repos/actions/runner/releases/latest --jq .tag_name)"; ver="${ver#v}"
  echo "→ downloading actions runner $ver ($plat) into $dir"
  mkdir -p "$dir"
  curl -fsSL "https://github.com/actions/runner/releases/download/v$ver/actions-runner-$plat-$ver.tar.gz" \
    | tar xz -C "$dir"
fi

echo "→ registering '$name' with https://github.com/$target"
token="$(gh api -X POST "$api/actions/runners/registration-token" --jq .token)"
( cd "$dir" && ./config.sh --unattended --replace \
    --url "https://github.com/$target" --token "$token" \
    --name "$name" --labels pr-demon --no-default-labels --work _work )

echo "→ installing the job-started hook"
cp "$here/job-started.sh" "$dir/pr-demon-job-started.sh"
chmod +x "$dir/pr-demon-job-started.sh"
touch "$dir/.env"
grep -v -E '^(ACTIONS_RUNNER_HOOK_JOB_STARTED|PR_DEMON_ALLOWED_WORKFLOWS)=' "$dir/.env" > "$dir/.env.tmp" || true
{
  echo "ACTIONS_RUNNER_HOOK_JOB_STARTED=$dir/pr-demon-job-started.sh"
  echo "PR_DEMON_ALLOWED_WORKFLOWS=${PR_DEMON_ALLOWED_WORKFLOWS:-*/.github/workflows/pr-demon.yml@refs/heads/main}"
} >> "$dir/.env.tmp"
mv "$dir/.env.tmp" "$dir/.env"

echo "→ installing as a service"
cd "$dir"
if [ "$(uname -s)" = Darwin ]; then ./svc.sh install || true; ./svc.sh start
else sudo ./svc.sh install "$USER" || true; sudo ./svc.sh start; fi

echo
echo "Done. Runner '$name' is online with label 'pr-demon'."
echo "Allowed workflows: see $dir/.env (PR_DEMON_ALLOWED_WORKFLOWS)."
