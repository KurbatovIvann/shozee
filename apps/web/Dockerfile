# Web panel static image (web-T2, ADR-0030): build apps/web, then serve the
# bundle with Caddy which also forwards /rpc and /api/auth to the API — the
# browser sees one origin, so CORS never activates and SameSite=Lax session
# cookies work unchanged (docs/design/web-panel-architecture.md).
#
# Build from the repo root (pnpm workspace context):
#   docker build -f apps/web/Dockerfile .

FROM node:24.19-alpine AS build
WORKDIR /repo
# corepack activates the pnpm version pinned by the root `packageManager`.
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter "@showzy/web..." \
  && pnpm --filter @showzy/web build

FROM caddy:2.11-alpine
COPY apps/web/deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv
