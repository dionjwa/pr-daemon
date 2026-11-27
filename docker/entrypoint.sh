#!/usr/bin/env bash
# Start pr-daemon in the container as an unprivileged user that can still use
# the three mounts and the Docker socket. Everything here is about the things a
# container gets wrong by default: file ownership across a bind mount, the
# group of the socket, git's identity and its owner check, and the fact that
# /etc/hosts arrives root-owned (hosts.ts needs to write it).
#
# Run as root, it fixes those and drops privileges. Run as a user already
# (`docker run --user`), it checks what it can and carries on.
set -euo pipefail

say() { echo "[pr-daemon-entrypoint] $*" >&2; }

USER_NAME=pr-daemon
CONFIG="${PR_DAEMON_CONFIG_HOME:-/pr-daemon/config}"
CREDS="${PR_DAEMON_CREDENTIALS_HOME:-/pr-daemon/credentials}"
WORK="${PR_DAEMON_WORK_HOME:-/pr-daemon/work}"

# ---------------------------------------------------------------- the mounts
for d in "$CONFIG" "$CREDS" "$WORK"; do
  [ -d "$d" ] || say "WARNING: $d is not a directory. Did the mount get left out of compose.yaml?"
done

# The work directory MUST be at the same path inside the container as it is on
# the host. A project's `up` runs `docker compose` against the host's daemon,
# and the bind mounts in its compose file are host paths: /pr-daemon/work/...
# as a container path would point at nothing on the host and the stack would
# come up empty. docker/compose.yaml mounts it as <path>:<path> for this
# reason; this catches an edit that breaks it.
if [ -n "${PR_DAEMON_WORK_HOST:-}" ] && [ "${PR_DAEMON_WORK_HOST}" != "$WORK" ]; then
  say "WARNING: the work disk is $PR_DAEMON_WORK_HOST on the host but $WORK in here."
  say "         Preview stacks bind-mount their worktree through the host's Docker, so the two paths have to be identical."
fi

# ---------------------------------------------------------------- privileges
if [ "$(id -u)" = "0" ]; then
  # Match the work mount's owner, so files pr-daemon writes are yours on the
  # host and files you write are readable in here. A root-owned mount (a fresh
  # Docker volume) is simply given to the user instead; only the top directory,
  # because a work disk can hold many gigabytes of clones.
  want_uid="${PR_DAEMON_UID:-}"
  want_gid="${PR_DAEMON_GID:-}"
  if [ -z "$want_uid" ] && [ -d "$WORK" ]; then
    own_uid="$(stat -c %u "$WORK")"; own_gid="$(stat -c %g "$WORK")"
    if [ "$own_uid" != "0" ]; then want_uid="$own_uid"; want_gid="$own_gid"; fi
  fi
  if [ -n "$want_uid" ] && [ "$want_uid" != "$(id -u "$USER_NAME")" ]; then
    say "running as uid $want_uid:${want_gid:-$want_uid} to match $WORK"
    groupmod -o -g "${want_gid:-$want_uid}" "$USER_NAME"
    usermod -o -u "$want_uid" -g "${want_gid:-$want_uid}" "$USER_NAME"
    chown -R "$want_uid:${want_gid:-$want_uid}" "/home/$USER_NAME"
  fi
  chown "$(id -u "$USER_NAME")" "$WORK" 2>/dev/null || true
  chown "$(id -u "$USER_NAME")" "$CONFIG" 2>/dev/null || true

  # The Docker socket's group. Its gid is the host's, so the group usually
  # doesn't exist in here; on Docker Desktop the socket is root-owned (gid 0)
  # and group 0 is the only way to reach it.
  SOCK="${DOCKER_HOST-}"; SOCK="${SOCK#unix://}"; SOCK="${SOCK:-/var/run/docker.sock}"
  if [ -S "$SOCK" ]; then
    sock_gid="$(stat -c %g "$SOCK")"
    group="$(getent group "$sock_gid" | cut -d: -f1 || true)"
    if [ -z "$group" ]; then group=dockersock; groupadd -g "$sock_gid" "$group"; fi
    usermod -aG "$group" "$USER_NAME"
    say "docker socket $SOCK: group $group ($sock_gid)"
    [ "$sock_gid" = "0" ] && say "NOTE: the socket is root-owned, so $USER_NAME is in group root to use it (normal on Docker Desktop)." || true
  else
    say "no Docker socket at $SOCK: preview stacks that use Docker will fail, and the preview proxy needs proxy = \"docker\"."
  fi

  # hosts.ts keeps a block of preview names in the container's own /etc/hosts
  # (never the host's). Docker mounts it root-owned, so hand it over now.
  chown "$(id -u "$USER_NAME")" /etc/hosts 2>/dev/null || say "could not take /etc/hosts; public preview names will not resolve in here"
fi

# ---------------------------------------------------------------- git
# Without an identity git refuses to commit, and a fresh container has none.
# The owner's name and email are theirs to choose; pr-daemon fills in the gh
# user's noreply address itself once it knows who it is acting as.
as_user() { if [ "$(id -u)" = "0" ]; then setpriv --reuid "$USER_NAME" --regid "$USER_NAME" --init-groups --inh-caps=-all env HOME="/home/$USER_NAME" "$@"; else "$@"; fi; }
if [ -n "${PR_DAEMON_GIT_NAME:-}" ]; then as_user git config --global user.name "$PR_DAEMON_GIT_NAME"; fi
if [ -n "${PR_DAEMON_GIT_EMAIL:-}" ]; then as_user git config --global user.email "$PR_DAEMON_GIT_EMAIL"; fi
# A worktree whose files belong to another uid (your host account) is "dubious
# ownership" to git, which then refuses to work in it at all.
as_user git config --global --replace-all safe.directory "*" 2>/dev/null || true

# ---------------------------------------------------------------- go
# A pr-daemon subcommand, or any other command (`docker compose run pr-daemon bash`).
case "${1:-serve}" in
  serve|status|stop|doctor|setup|ref|run|install-service|uninstall-service|help|-h|--help)
    set -- pr-daemon "$@" ;;
esac
say "starting: $*"
if [ "$(id -u)" = "0" ]; then
  exec setpriv --reuid "$USER_NAME" --regid "$USER_NAME" --init-groups --inh-caps=-all \
    env HOME="/home/$USER_NAME" USER="$USER_NAME" "$@"
fi
exec "$@"
