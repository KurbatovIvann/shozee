# Runbook — `apps/sho` (Шо parse service)

ADR-0051. `apps/sho` is the only importer of `packages/sho` (the vendored
runtime and model); `apps/api` and `apps/sho` share wire types through
`@showzy/sho-protocol` and nothing else. The service reaches no database and
holds no tenant data beyond the ids and names in a context.

## Run it

```
pnpm --filter @showzy/sho-service start
```

Environment (`packages/config`, `.env.example`):

| key | who reads it | notes |
| --- | --- | --- |
| `SHO_PORT` | `apps/sho` | listen port, default 3100, internal only |
| `SHO_WORKERS` | `apps/sho` | parse pool size; unset means CPU count − 1. Each worker holds its own runtime and compiled-context cache (~140 MB) |
| `SHO_SERVICE_TOKEN` | both | shared bearer, ≥ 32 chars, secret |
| `SHO_URLS` | `apps/api` | comma-separated replica base URLs; empty means no Шо and every staff turn goes to the LLM |

`apps/sho` refuses to boot without `SHO_SERVICE_TOKEN`. `apps/api` refuses to
boot when `SHO_URLS` is set and the token is not.

## Endpoints (`/v1`)

`GET /health` is the only unauthenticated route. Every other route needs
`Authorization: Bearer ${SHO_SERVICE_TOKEN}`; the check compares SHA-256
digests with `timingSafeEqual`, so it is constant-time and does not leak the
token's length.

`GET /ready` answers `{"ready": false}` until the model has loaded; the other
routes answer `503 busy` in that window. `PUT /contexts/{companyId}:{scopeHash}`
stores a gzipped `{fingerprint, context}` and compiles it; a body over 8 MB is
refused `413 context_limit` before it is read, a context over a list, count or
length limit is `413 context_limit`, and a malformed one is `400 input`.
`POST /parse` answers `409 context_required` on a cache miss or a fingerprint
that does not match the stored one, and never parses against a stale context.
`GET /contexts/{key}/phrases?companyId=…` returns product, variant and customer
names for speech hints; the key must belong to the asking company.

T7 runs `SHO_WORKERS` parse workers (`worker_threads`), each with its own
runtime and compiled-context cache. A context key always goes to the same
worker (FNV-1a of the key modulo the pool size), so a context is compiled and
held once, on one worker. Each worker runs one job at a time behind a bounded
queue (`SHO_QUEUE_LIMIT`, 8 per worker): a full queue, a worker that is still
loading its model, and a crashed worker's waiting jobs all answer `503 busy`.
A job that outlives its deadline (the request's `deadlineMs` for a parse,
`SHO_CALL_TIMEOUT_MS` 30 s for a context upload or a phrases read) answers
`504 deadline`; when that job had already started, the worker is terminated and
replaced, so a hung run no longer wedges the pool. A replaced worker starts
with an empty cache, so the next parse for its keys is `409 context_required`
and the API re-uploads.

Each `POST /parse` logs one line: `requestId`, `outcome`
(`ok` | `input` | `context_required` | `busy` | `deadline` | `failed`) and
`ms`. Never the command text. `failed` is a worker-side throw that is not an
`InputError`; it answers 500.

## Diagnosing a turn that fell through to the LLM

1. `GET /v1/model` — compare `labelsMd5` with the API's mapping table and
   `md5` with the model the API logged for the turn.
2. `GET /v1/ready` — a `false` here explains every `503` in the window.
3. A run of `409 context_required` means the API's fingerprint TTL and the
   service's cached fingerprint disagree; a `413 context_limit` means the
   tenant's context passed 8 MB (~13k products × 4 variants).

## Recorded, not built (no production exists)

- `shoClientConfigSchema` permits `http://` replicas, so the service token and
  the context travel in plaintext on an untrusted network. Production requires
  TLS between `apps/api` and `apps/sho`, or a network where plaintext is
  acceptable, plus token rotation.
- The context cache budget (`SHO_CONTEXT_CACHE_UPLOAD_BYTES`, 256 MB per
  worker) counts **uploaded JSON bytes**, not the compiled index's heap
  footprint — the runtime exposes no size for a `CompiledContext`, and the two
  are not proportional. Sizing the cache against real memory needs that number
  first. Replica count and capacity are unsized.
- Deploy ordering between `apps/api` and `apps/sho`, model rollout and
  rollback, and warm-up on deploy.
- The retraining store (ADR-0049/0051: dev and test companies only) lives in
  `apps/api`, not here; this service stores nothing.
