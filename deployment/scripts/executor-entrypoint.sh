#!/usr/bin/env bash
# executor-entrypoint.sh — runs as root in the executor container.
#
# 1. Sets up the agenticnet user's ~/.ssh directory (mode 700, owner agenticnet)
#    and pre-populates known_hosts via ssh-keyscan against $GIT_SERVER_HOST
#    (the host portion of the remote URL) so `git clone` doesn't get a
#    host-key prompt and StrictHostKeyChecking can stay enabled.
# 2. Ensures /workspace is owned by agenticnet (chown -R is idempotent and
#    cheap for a fresh clone; ~ms on subsequent boots).
# 3. On first start, clones $GIT_REMOTE_URL into /workspace/<repo-basename>
#    using a private key bind-mounted at /etc/ssh-team-key/id_ed25519. On
#    subsequent starts, fetches latest from origin. Both run as the
#    agenticnet user.
# 4. exec-drops to agenticnet via su-exec and starts the JVM.
#
# All git-related steps fail soft: if no remote is configured (GIT_REMOTE_URL
# empty), no team-key mounted, or ssh-keyscan can't reach the host, the
# script logs a warning and proceeds. The executor JVM itself doesn't need
# git/claude to start — those tools are needed only when a CommandToken
# transition runs them.

set -euo pipefail

WORKSPACE="${EXECUTOR_WORKSPACE:-/workspace}"
GIT_REMOTE="${GIT_REMOTE_URL:-}"
GIT_SERVER_HOST="${GIT_SERVER_HOST:-}"
SSH_KEY_DIR=/etc/ssh-team-key
SSH_KEY="${SSH_KEY_DIR}/id_ed25519"
AGENTICNET_HOME=/home/agenticnet
KNOWN_HOSTS="${AGENTICNET_HOME}/.ssh/known_hosts"

log() { printf '[executor-entrypoint] %s\n' "$*"; }

# 1. Prepare agenticnet's ~/.ssh
install -o agenticnet -g agenticnet -m 700 -d "${AGENTICNET_HOME}/.ssh"

# Pre-populate known_hosts so SSH StrictHostKeyChecking can stay strict.
if [[ -n "${GIT_SERVER_HOST}" ]]; then
    log "scanning ${GIT_SERVER_HOST} for SSH host keys"
    if scanned="$(ssh-keyscan -t ed25519,rsa -H "${GIT_SERVER_HOST}" 2>/dev/null)" && [[ -n "${scanned}" ]]; then
        printf '%s\n' "${scanned}" > "${KNOWN_HOSTS}"
        chown agenticnet:agenticnet "${KNOWN_HOSTS}"
        chmod 600 "${KNOWN_HOSTS}"
        log "known_hosts populated ($(wc -l < "${KNOWN_HOSTS}") line(s))"
    else
        log "warning: ssh-keyscan ${GIT_SERVER_HOST} returned nothing — clone will accept-new"
    fi
fi

# 2. Ensure team-key permissions are sane (defensive — the bind mount may have
# inherited a non-600 mode on Mac Docker Desktop).
if [[ -f "${SSH_KEY}" ]]; then
    chmod 600 "${SSH_KEY}" 2>/dev/null || true
    chown agenticnet:agenticnet "${SSH_KEY}" 2>/dev/null || true
fi

# 3. Workspace setup
mkdir -p "${WORKSPACE}"
chown -R agenticnet:agenticnet "${WORKSPACE}"

# Configure the git SSH command for the agenticnet user. Exporting it here
# is enough for the clone/fetch below; the developer transition that runs
# Claude Code later inherits it from the JVM's environment.
if [[ -f "${SSH_KEY}" ]]; then
    GIT_SSH_COMMAND="ssh -i ${SSH_KEY} -o UserKnownHostsFile=${KNOWN_HOSTS} -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes"
    export GIT_SSH_COMMAND
fi

if [[ -n "${GIT_REMOTE}" ]]; then
    repo_basename="$(basename "${GIT_REMOTE%.git}")"
    repo_dir="${WORKSPACE}/${repo_basename}"
    if [[ ! -d "${repo_dir}/.git" ]]; then
        log "cloning ${GIT_REMOTE} into ${repo_dir}"
        if ! su-exec agenticnet:agenticnet env GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-}" \
                git clone "${GIT_REMOTE}" "${repo_dir}" 2>&1; then
            log "warning: clone failed; the developer chain will fail until this is fixed"
        fi
    else
        log "workspace already cloned at ${repo_dir}; fetching latest"
        if ! su-exec agenticnet:agenticnet env GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-}" \
                git -C "${repo_dir}" fetch --all 2>&1; then
            log "warning: fetch failed; continuing with the existing checkout"
        fi
    fi

    # Ensure git knows who is committing inside the container. Without this,
    # `git commit` aborts with "Please tell me who you are." even with a clean
    # working tree.
    su-exec agenticnet:agenticnet git config --global user.email \
        "${GIT_AUTHOR_EMAIL:-executor@agenticos.local}"
    su-exec agenticnet:agenticnet git config --global user.name \
        "${GIT_AUTHOR_NAME:-agenticos executor}"
else
    log "no GIT_REMOTE_URL configured — workspace will be empty until first push from outside"
fi

# 4. Drop to agenticnet and start the JVM. exec replaces the script process so
# tini (PID 1) tracks the JVM directly.
log "starting JVM as agenticnet"
exec su-exec agenticnet:agenticnet sh -c 'exec java $JAVA_OPTS -jar /app/app.jar'
