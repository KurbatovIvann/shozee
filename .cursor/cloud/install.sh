#!/usr/bin/env bash
#
# Idempotent install/bootstrap for the Showzy 2.0 Cloud Agent environment.
#
# Runs after the repository is checked out. It prepares the durable state the
# development stack and test suite depend on:
#   1. Docker Engine + the fuse-overlayfs storage driver (the local dev stack
#      and Testcontainers-based tests both need a working daemon inside this
#      nested-container VM);
#   2. the /etc/docker/daemon.json that pins the fuse-overlayfs driver;
#   3. workspace JavaScript dependencies (pnpm, frozen lockfile).
#
# Nothing here starts a long-running process — the daemon and the dev stack are
# brought up per boot by start.sh. Safe to re-run: every step is a no-op when
# the state it creates already exists.
set -euo pipefail

cd "$(dirname "$0")/../.." # repo root

log() { printf '[install] %s\n' "$*"; }

# --- 1. Docker Engine + fuse-overlayfs --------------------------------------
# Cloud Agent VMs are themselves containers, so the default overlay2 driver is
# unavailable; fuse-overlayfs is the supported rootful driver here. Install the
# packages only when the docker binary is missing so snapshot/build boots that
# already carry them skip straight to dependency install.
if ! command -v dockerd >/dev/null 2>&1; then
  log "installing docker engine + fuse-overlayfs"
  sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    -o Dpkg::Options::="--force-confold" \
    docker.io docker-compose-v2 fuse-overlayfs fuse3 uidmap iptables
else
  log "docker already installed: $(dockerd --version)"
fi

# --- 2. Daemon storage-driver config ----------------------------------------
sudo mkdir -p /etc/docker
if ! grep -q '"storage-driver": "fuse-overlayfs"' /etc/docker/daemon.json 2>/dev/null; then
  log "writing /etc/docker/daemon.json (fuse-overlayfs)"
  printf '{\n  "storage-driver": "fuse-overlayfs"\n}\n' | sudo tee /etc/docker/daemon.json >/dev/null
fi

# --- 3. pnpm toolchain -------------------------------------------------------
# pnpm 12 ships as a Rust native binary behind a thin wrapper. pnpm's own
# package-manager-version manager materializes the pinned `packageManager`
# (pnpm@12.3.2) from a bare `npm install`, which skips the wrapper's build
# script, so `bin/pnpm` is left as a text placeholder. Invoking it then dies
# with "Syntax error: ) unexpected" (a shell trying to run that stub). Pin the
# version through Corepack instead: its shim loads the wrapper's Corepack entry
# (bin/pnpm.mjs), which fetches and caches the real native binary next to the
# wrapper. Idempotent: once a working pnpm resolves, this whole block is a
# no-op, and a materialized binary carried in a snapshot is reused offline.
pm_version="$(node -p "require('./package.json').packageManager" 2>/dev/null || echo pnpm@12.3.2)"
if ! pnpm --version >/dev/null 2>&1; then
  log "bootstrapping ${pm_version} via corepack"
  corepack enable pnpm
  corepack prepare "${pm_version}" --activate
  pnpm --version >/dev/null # force the one-time native-binary download now
fi
log "pnpm ready: $(pnpm --version)"

# --- 4. Workspace dependencies ----------------------------------------------
log "installing workspace dependencies (pnpm, frozen lockfile)"
pnpm install --frozen-lockfile

log "install complete"
