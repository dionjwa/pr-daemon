#!/usr/bin/env bash
# Remove the pr-demon runner installed by install.sh.
#   runner/uninstall.sh owner/repo | org
set -euo pipefail
target="${1:?usage: uninstall.sh <owner/repo | org>}"
dir="${PR_DEMON_RUNNER_DIR:-$HOME/actions-runner-pr-demon}"
if [[ "$target" == */* ]]; then api="repos/$target"; else api="orgs/$target"; fi
cd "$dir"
if [ "$(uname -s)" = Darwin ]; then ./svc.sh stop || true; ./svc.sh uninstall || true
else sudo ./svc.sh stop || true; sudo ./svc.sh uninstall || true; fi
token="$(gh api -X POST "$api/actions/runners/remove-token" --jq .token)"
./config.sh remove --token "$token"
echo "Removed. You can now delete $dir"
