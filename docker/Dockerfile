# pr-daemon in a container: the daemon, the agents, and every tool the target
# repositories need. Nothing of the host comes in except three mounts and the
# Docker socket (docs/container.md explains why each one is there).
#
# The base is the full node:24 image, not -slim: an agent works in somebody
# else's repository, and build-essential, python3, git and openssh are the tools
# its install and test steps expect to find.
FROM node:24-bookworm

# Versions worth pinning are pinned where it matters: gh must be >= 2.73 (older
# `gh pr edit` asks GitHub for the sunset Projects (classic) fields and fails).
ARG DEBIAN_FRONTEND=noninteractive
# Extra apt packages your repositories need, e.g. --build-arg EXTRA_APT="redis-tools postgresql-client"
ARG EXTRA_APT=""
# Chromium for the screenshots a PR gets. ~400 MB; set false if you don't want it.
ARG WITH_PLAYWRIGHT=true

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# ---------------------------------------------------------------- base tools
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl dnsutils gnupg jq less lsof procps rsync sqlite3 unzip zip \
      locales tini ripgrep \
      ${EXTRA_APT} \
 && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------- gh and the docker client
# The Docker CLI only: the daemon it talks to is the host's, through the
# mounted socket. compose and buildx are plugins a project's `up` may use.
RUN install -m 0755 -d /usr/share/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli.gpg \
 && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /usr/share/keyrings/docker.gpg \
 && arch="$(dpkg --print-architecture)" \
 && echo "deb [arch=$arch signed-by=/usr/share/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && echo "deb [arch=$arch signed-by=/usr/share/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh docker-ce-cli docker-buildx-plugin docker-compose-plugin \
 && rm -rf /var/lib/apt/lists/* \
 && gh --version | head -1

# ---------------------------------------------------------------- just, deno
# `just` is the command runner every pr-daemon contract is written in.
RUN curl --proto '=https' --tlsv1.2 -sSf https://just.systems/install.sh | bash -s -- --to /usr/local/bin \
 && just --version
# Deno: the toolchain of the repositories pr-daemon was built for. Pulled by
# architecture rather than through its install script, which wants a $HOME.
RUN set -eu; case "$(dpkg --print-architecture)" in \
      amd64) target=x86_64-unknown-linux-gnu ;; \
      arm64) target=aarch64-unknown-linux-gnu ;; \
      *) echo "no deno build for $(dpkg --print-architecture)"; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/deno.zip "https://github.com/denoland/deno/releases/latest/download/deno-${target}.zip"; \
    unzip -q /tmp/deno.zip -d /usr/local/bin; rm /tmp/deno.zip; deno --version | head -1

# ---------------------------------------------------------------- your projects' own tools
# Whatever your repositories need that isn't a Debian package: one shell command
# line, run as root during the build (PR_DAEMON_EXTRA_SETUP in docker/.env). The
# nhost, supabase, flyctl and wrangler CLIs all install this way. Empty by
# default, so an untouched checkout builds the same image for everyone. Pin a
# version in it: a build that follows "latest" changes under you.
ARG EXTRA_SETUP=""
RUN if [ -n "$EXTRA_SETUP" ]; then bash -eux -o pipefail -c "$EXTRA_SETUP"; fi

# ---------------------------------------------------------------- the agent
# Claude Code itself. Its login is a token from the credentials mount, read on
# every run (agent.ts), never baked in here.
RUN npm install -g @anthropic-ai/claude-code && claude --version

# Chromium and its libraries, in the system location so any project's
# Playwright finds them (PLAYWRIGHT_BROWSERS_PATH below).
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN if [ "$WITH_PLAYWRIGHT" = "true" ]; then \
      npx -y playwright@latest install --with-deps chromium \
      && chmod -R a+rX /opt/playwright; \
    else echo "skipping playwright"; fi \
 && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------- pr-daemon
# The source lives in the image, not in a mount: an agent can reach every
# mounted path, and pr-daemon's own code is not something it should be able to
# edit. Picking up a code change is `just container-restart`.
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY bin ./bin
COPY src ./src
COPY prompts ./prompts
COPY docs ./docs
COPY examples ./examples
COPY tsconfig.json justfile README.md CLAUDE.md ./
RUN ln -s /app/bin/pr-daemon /usr/local/bin/pr-daemon

# ---------------------------------------------------------------- the user
# Not root. The uid/gid are adjusted at start to match the work mount's owner,
# and the group of the Docker socket is joined there too (entrypoint.sh).
ARG PR_DAEMON_UID=10001
ARG PR_DAEMON_GID=10001
RUN groupadd -g "$PR_DAEMON_GID" pr-daemon \
 && useradd -m -u "$PR_DAEMON_UID" -g "$PR_DAEMON_GID" -s /bin/bash pr-daemon

# Where the three mounts land. Defaults, so `docker run` with nothing set still
# puts every path where docker/compose.yaml expects it.
ENV PR_DAEMON_CONFIG_HOME=/pr-daemon/config \
    PR_DAEMON_CREDENTIALS_HOME=/pr-daemon/credentials \
    PR_DAEMON_WORK_HOME=/pr-daemon/work \
    PR_DAEMON_LOCAL_HOST=host.docker.internal \
    NPM_CONFIG_UPDATE_NOTIFIER=false
RUN mkdir -p /pr-daemon/config /pr-daemon/credentials /pr-daemon/work \
 && chown -R pr-daemon:pr-daemon /pr-daemon

COPY docker/entrypoint.sh /usr/local/bin/pr-daemon-entrypoint
RUN chmod 0755 /usr/local/bin/pr-daemon-entrypoint

# tini reaps the zombies an agent's tool processes leave behind. `-s` registers
# it as a child subreaper, so it still works when something else is PID 1
# (`docker run --init`, or compose's `init: true` — which compose.yaml therefore
# leaves off, to keep one init rather than two).
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/usr/local/bin/pr-daemon-entrypoint"]
CMD ["serve"]
