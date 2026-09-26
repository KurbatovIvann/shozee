#!/bin/bash
# Claude Code on the web: make pnpm 12, workspace deps, and Docker
# (Testcontainers for test:db) ready before the session starts.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"
mkdir -p .agent-tmp

pnpm_version="$(node -p "require('./package.json').packageManager.split('@')[1]")"

# pnpm 12 ships a native binary that its install script links in place of a
# placeholder. The preinstalled pnpm downloads the pinned version with scripts
# disabled, so link the binary ourselves when the placeholder is still there.
if [ "$(pnpm -v 2>/dev/null || true)" != "$pnpm_version" ]; then
  pnpm_home="${PNPM_HOME:-$HOME/.local/share/pnpm}"
  wrapper="$pnpm_home/.tools/pnpm/$pnpm_version/node_modules/pnpm"
  if [ -f "$wrapper/install.js" ]; then
    (cd "$wrapper" && node install.js)
  fi
fi
echo "pnpm $(pnpm -v)"

pnpm install --frozen-lockfile > .agent-tmp/session-start-install.log 2>&1 \
  || { tail -40 .agent-tmp/session-start-install.log >&2; exit 1; }
echo "pnpm install: ok"

if command -v dockerd > /dev/null 2>&1 && ! docker info > /dev/null 2>&1; then
  setsid nohup dockerd > .agent-tmp/dockerd.log 2>&1 &
  for _ in $(seq 1 60); do
    docker info > /dev/null 2>&1 && break
    sleep 1
  done
fi

if docker info > /dev/null 2>&1; then
  docker image inspect postgres:17-alpine > /dev/null 2>&1 \
    || docker pull -q postgres:17-alpine > /dev/null 2>&1 \
    || echo "warning: could not pre-pull postgres:17-alpine" >&2
  echo "docker: ok"
else
  echo "warning: Docker is not running; test:db will be blocked" >&2
fi
