# just docs: https://github.com/casey/just
set shell       := ["bash", "-c"]
set dotenv-load := true

# Where pr-daemon keeps its state, and the status page port, read from the live
# config so the links below follow it. Interpolated, never exported: `set export`
# would push PORT into the project stacks pr-daemon launches, and their justfiles
# read PORT to pick a per-branch dev port.
PR_DAEMON_HOME := env_var_or_default("PR_DAEMON_HOME", env_var("HOME") + "/.pr-daemon")
PAGE_PORT      := `p=$(sed -n 's/^port *= *\([0-9][0-9]*\).*/\1/p' "${PR_DAEMON_HOME:-$HOME/.pr-daemon}/config.toml" 2>/dev/null | head -1); echo "${p:-7377}"`

# minimal formatting, bold is very useful
bold    := '\033[1m'
normal  := '\033[0m'
green   := "\\e[32m"
yellow  := "\\e[33m"
blue    := "\\e[34m"
magenta := "\\e[35m"
cyan    := "\\e[36m"
grey    := "\\e[90m"

_help:
    #!/usr/bin/env bash
    echo ""
    just --list --unsorted --list-heading $'😈 pr-daemon — label a GitHub issue `agent`, get a pull request:\n'
    echo -e ""
    echo -e "    {{ bold }}Get started{{ normal }} (one machine, one long-running process):"
    echo -e "        1. {{ cyan }}gh auth login{{ normal }}            # pr-daemon acts as you, through gh"
    echo -e "        2. {{ cyan }}just doctor{{ normal }}              # writes the config, checks tools and logins"
    echo -e "        3. {{ cyan }}just config{{ normal }}              # add your repo: [[repos]] name = \"owner/repo\""
    echo -e "        4. {{ cyan }}just install-service{{ normal }}     # run now and at login ({{ cyan }}just start{{ normal }} to stay in the terminal)"
    echo -e "        5. label an issue {{ yellow }}agent{{ normal }} → a PR appears. Ask for changes with a PR"
    echo -e "           comment starting {{ yellow }}/pr-daemon{{ normal }}. You merge; it never does."
    echo -e ""
    echo -e "    Your project needs two commands — start this branch's stack, and stop it."
    echo -e "        Any shell command will do. {{ cyan }}just setup{{ normal }} prints the whole contract"
    echo -e "        (also at {{ green }}http://localhost:{{ PAGE_PORT }}/setup{{ normal }}, to hand to an agent);"
    echo -e "        {{ cyan }}just contract{{ normal }} prints a justfile to copy. {{ cyan }}just where{{ normal }} shows the checkouts."
    echo -e ""
    echo -e "    Links:"
    echo -e "        status page:  {{ green }}http://localhost:{{ PAGE_PORT }}{{ normal }}"
    echo -e "        github:       {{ green }}https://github.com/metapages/pr-daemon{{ normal }}"
    echo -e "        config:       {{ grey }}{{ PR_DAEMON_HOME }}/config.toml{{ normal }}"
    echo -e "        log:          {{ grey }}{{ PR_DAEMON_HOME }}/pr-daemon.log{{ normal }}"
    echo -e "        docs:         {{ grey }}README.md{{ normal }} (setup) · {{ grey }}CLAUDE.md{{ normal }} (how it works) · {{ grey }}journal.md{{ normal }} (history)"
    echo -e ""

# Run the process in this terminal: poll GitHub, run agents, serve the status page
@start: _ensure_node_modules
    ./bin/pr-daemon serve

# Like start, but restart on every change to src/. Caddy and the status page come back with it
@dev: _ensure_node_modules
    node --watch --no-warnings=ExperimentalWarning src/cli.ts serve

# What's running, queued and paused, plus the live preview stacks
@status: _ensure_node_modules
    ./bin/pr-daemon status

# Follow the service log
@logs:
    tail -f "{{ PR_DAEMON_HOME }}/pr-daemon.log"

# Open the status page in a browser
@open:
    {{ if os() == "macos" { "open" } else { "xdg-open" } }} http://localhost:{{ PAGE_PORT }}

# What a project must do to take part — hand this to an agent, or read it yourself
@setup:
    ./bin/pr-daemon setup

# Where the clones, worktrees and agent logs live, and what is checked out right now
where:
    #!/usr/bin/env bash
    set -euo pipefail
    H="{{ PR_DAEMON_HOME }}"
    echo -e "{{ bold }}$H{{ normal }}"
    echo -e "  config.toml                      settings (also the Config tab on the status page)"
    echo -e "  repos/<org>__<repo>/             the cached clone of each repo"
    echo -e "  worktrees/<org>__<repo>/<branch>/  {{ cyan }}the checkout an agent works in; up/down/check run here{{ normal }}"
    echo -e "  out/<org>__<repo>/<branch>/      prompts, agent logs (*.jsonl), PR text, screenshots"
    echo -e "  pr-daemon.log                    the service log"
    echo -e ""
    if compgen -G "$H/worktrees/*/*" > /dev/null; then
      echo -e "{{ bold }}Checked out now{{ normal }}"
      for d in "$H"/worktrees/*/*; do echo "  $d"; done
    else
      echo -e "{{ grey }}No worktrees right now.{{ normal }}"
    fi

# Check tools, logins, config and the preview proxy. Creates the config on first run
@doctor: _ensure_node_modules
    ./bin/pr-daemon doctor

# Show the config. Edit it here or on the Config tab of the status page (it validates before saving)
@config:
    echo -e "{{ grey }}{{ PR_DAEMON_HOME }}/config.toml{{ normal }}" && cat "{{ PR_DAEMON_HOME }}/config.toml"

# One job inline, no daemon: just run <build|review|revise|teardown|restart> owner/repo 42 ['feedback']
run kind repo number feedback="": _ensure_node_modules
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -n "{{ feedback }}" ]; then exec ./bin/pr-daemon run {{ kind }} {{ repo }} {{ number }} "{{ feedback }}"; fi
    exec ./bin/pr-daemon run {{ kind }} {{ repo }} {{ number }}

# Start pr-daemon now and at every login (macOS launchd / Linux systemd --user)
@install-service: _ensure_node_modules
    ./bin/pr-daemon install-service

# Restart the installed service to pick up code changes in this checkout
restart:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "$(uname)" = "Darwin" ]; then launchctl kickstart -k "gui/$(id -u)/pr-daemon"
    else systemctl --user restart pr-daemon; fi
    echo -e "✅ restarted. Jobs that were running are re-queued and resume their Claude sessions."
    echo -e "   logs: {{ cyan }}just logs{{ normal }}"

# Stop the service and remove it. Caddy stops with it; preview stacks keep running
@uninstall-service:
    ./bin/pr-daemon uninstall-service

# TypeScript check (no build step; this is what CI runs)
@check: _ensure_node_modules
    npm run check && echo -e "✅ {{ green }}TypeScript{{ normal }} check passed"

# Unit tests: the pure logic (amounts, durations, templates, config, budget, Caddy config)
@test *args: _ensure_node_modules
    npm test {{ args }}

# Everything CI runs: typecheck + unit tests
ci: check test

# Print the two recipes your project has to add, ready to paste into its justfile
@contract:
    cat examples/justfile

# Follow Caddy's log (public previews, binary mode; in docker mode: docker logs -f pr-daemon-caddy)
@logs-caddy:
    tail -f "{{ PR_DAEMON_HOME }}/caddy/caddy.log"

# The SQLite state (jobs, token ledger, stacks, events): just db ['select * from jobs limit 5;']
db sql="":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -n "{{ sql }}" ]; then exec sqlite3 "{{ PR_DAEMON_HOME }}/pr-daemon.db" "{{ sql }}"; fi
    exec sqlite3 "{{ PR_DAEMON_HOME }}/pr-daemon.db"

@_ensure_node_modules:
    if [ ! -d node_modules ]; then npm install; fi
