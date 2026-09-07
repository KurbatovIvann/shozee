#!/usr/bin/env bash
#
# Run the @showzy/worker process (outbox poller + delivery executor) directly
# from TypeScript sources for local development.
#
# Like the API, the worker uses NodeNext ".js" import specifiers that point at
# ".ts"/".tsx" sources, so it shares the workspace's canonical resolver hook
# (packages/db/scripts/ts-resolve-hooks.mjs) which bridges the extension and
# transpiles the doc-generation ".tsx" PDF templates the worker renders. Type
# *transform* (not strip-only) is required for TypeScript parameter properties.
# Requires the dev stack from start.sh (Postgres + Redis).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/../.." # repo root
repo_root="$(pwd)"

# Node's type stripping needs Node >= 22.18. The base image ships that via nvm;
# the default PATH node may be older, so select the newest installed v22.
nvm_dir="${NVM_DIR:-$HOME/.nvm}"
node_dir="$(ls -d "$nvm_dir"/versions/node/v22.* 2>/dev/null | sort -V | tail -1 || true)"
if [ -n "$node_dir" ]; then
  export PATH="$node_dir/bin:$PATH"
fi

node_major_minor="$(node -p 'process.versions.node.split(".").slice(0,2).join(".")' 2>/dev/null || echo 0.0)"
awk -v v="$node_major_minor" 'BEGIN { split(v, p, "."); if (p[1] < 22 || (p[1] == 22 && p[2] < 18)) exit 1 }' || {
  echo "[run-worker] Node >= 22.18 is required for TypeScript type transform (found $node_major_minor)" >&2
  exit 1
}

[ -f .env ] || cp .env.example .env
set -a
. ./.env
set +a

export NODE_OPTIONS="--experimental-transform-types --import ${repo_root}/packages/db/scripts/ts-resolve-register.mjs"

echo "[run-worker] starting @showzy/worker with node $(node --version)"
exec node apps/worker/src/index.ts
