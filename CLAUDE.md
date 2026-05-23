# AOCR Agent Guide

## Read First

- `ARCH.md` is the fastest way to rebuild the runtime model of this repo.
- `README.md` explains the product surface, hosted usage, and `/v1/images` API.
- `SELF_HOSTING.md` explains operator setup and install-time secrets.
- `MIRROR.md` explains the pull-through mirror architecture, routes, and retention.
- `RETENTION.md` is the contract for tag cleanup semantics.
- `OBSERVABILITY.md` covers metrics, dashboards, and scrape wiring.
- `ansible/README.md` explains deploy-time secret generation and live schema sync.
- `aocr_aerol_stitch.md` is the end-to-end AOCR to AerolVM integration guide.
- `understanding.md` is the shortest push and reap lifecycle walkthrough.
- `plans/` contains design docs and future work. Treat plans as intent, not live behavior, unless the code matches.

## Monorepo Map

| Path | Purpose | Start Here |
| --- | --- | --- |
| `auth/` | Docker token auth service. Validates upstream tokens, static PATs, and cluster PATs, signs `/v2/token` JWTs, and serves `/v1/images`. | `auth/src/server.ts`, `auth/src/imageList.ts` |
| `hooks/` | Shared codebase for the webhook API, scheduled reaper, and internal blob/import APIs. | `hooks/src/controllers/HookAPI.ts`, `hooks/src/controllers/ImportAPI.ts`, `hooks/src/util/imageRetention.ts` |
| `mirror/` | Go pull-through mirror proxy, upstream routing, cache warming, and writer-side uploads. | `mirror/main.go`, `mirror/proxy.go`, `mirror/router.go` |
| `web/` | Next.js marketing and documentation site, not an admin console. | `web/src/app/page.tsx`, `web/src/components/` |
| `registry/` | Docker Distribution config template and container wrapper scripts. | `registry/config.yml` |
| `db/` | Bootstrap schema and manual migrations. | `db/init.sql` |
| `helm/aocr/` | Kubernetes deployment chart, including embedded SQL and service templates. | `helm/aocr/values.yaml` |
| `ansible/` | Helm deployment wrapper for VM-backed operations plus live schema catch-up. | `ansible/playbooks/deploy-aocr.yml`, `ansible/playbooks/apply-db-schema.yml` |
| `deploy/grafana/` | Importable Grafana dashboard JSON. | `deploy/grafana/aocr-observability-dashboard.json` |
| `docker-compose*.yaml` | Local stack plus metrics and GC overrides, including mirror and mirror-writer. | `docker-compose.yaml` |
| `.github/workflows/` | CI publishing for auth, hooks, reaper, registry, web, mirror, and the Helm chart. | `.github/workflows/deploy.yml` |

## Route By Task

- Docker login, bearer token issuance, scope bugs: `auth/src/server.ts`.
- `/v1/images` pagination, auth scope, and response shape: `auth/src/server.ts`, `auth/src/imageList.ts`.
- Cluster PAT parsing and namespace restrictions: `auth/src/clusterPat.ts`.
- Auth metrics: `auth/src/metrics.ts`.
- Registry webhook ingestion for push and pull events: `hooks/src/controllers/HookAPI.ts`.
- Internal blob-presence and import APIs: `hooks/src/controllers/InternalAPI.ts`, `hooks/src/controllers/ImportAPI.ts`, `hooks/src/util/mountFromRepo.ts`.
- Retention suffix parsing and provenance inference: `hooks/src/util/tagRetention.ts`.
- Reaper selection logic and registry manifest deletion: `hooks/src/util/imageRetention.ts`.
- Hook server wiring and CLI entrypoints: `hooks/src/server/server.ts`, `hooks/src/commands/hooks.ts`, `hooks/src/commands/reap.ts`.
- Mirror route parsing and upstream selection: `mirror/router.go`, `mirror/upstream.go`.
- Mirror cache warming, manifest dependency ordering, and writer uploads: `mirror/proxy.go`, `mirror/writer.go`, `mirror/config.go`.
- Database columns and retention schema: `db/init.sql`.
- Registry notification and token auth configuration: `registry/config.yml`.
- Helm deployment wiring: `helm/aocr/values.yaml` and `helm/aocr/templates/`.
- Live schema catch-up and deploy sequencing: `ansible/playbooks/deploy-aocr.yml`, `ansible/playbooks/apply-db-schema.yml`, `ansible/README.md`.
- Local development topology: `docker-compose.yaml`, `docker-compose.metrics.yaml`, `docker-compose.gc.yaml`.
- Publish pipeline: `.github/workflows/deploy.yml`.

## Source Of Truth

- Edit `auth/src/**`, not `auth/dist-test/**`.
- Edit `hooks/src/**` and `hooks/test/**`, not `hooks/build/**` or `hooks/build-test/**`.
- Edit `mirror/*.go` and `mirror/*_test.go` for mirror behavior.
- The schema bootstrap lives in `db/init.sql`. Keep `helm/aocr/files/init.sql` in sync when schema changes.
- The web source of truth is `web/src/**`; the app is mostly static sections under `web/src/components/`.

## Useful Existing Docs

- Hosted usage, mirror-facing APIs, and `/v1/images`: `README.md`
- Self-hosting: `SELF_HOSTING.md`
- Mirror architecture and operator checks: `MIRROR.md`
- Retention semantics and GC caveat: `RETENTION.md`
- Metrics and dashboards: `OBSERVABILITY.md`
- Deployment, schema upgrades, and secret handling: `ansible/README.md`
- AOCR to AerolVM stitch flow: `aocr_aerol_stitch.md`
- Runtime lifecycle walkthrough: `understanding.md`
- Longer narrative architecture writeup: `aocr_architecture_blog.md`

## Repo Skills

- `.claude/skills/aocr-navigation/`: repo map and first-file routing for most tasks.
- `.claude/skills/aocr-retention/`: retention, provenance, webhook, and reaper tracing.
- `.claude/skills/aocr-operations/`: Compose, Helm, Ansible, metrics, GC, and CI routing.

## Validation Commands

- Auth: `cd auth && corepack enable && pnpm install --frozen-lockfile && pnpm test`
- Hooks: `cd hooks && npm install && npx tsc -p tsconfig.json && npm test`
- Mirror: `cd mirror && go test ./...`
- Web: `cd web && npm install && npm run lint && npm run build`
- Helm: `helm lint helm/aocr`
- Ansible syntax: `cd ansible && ansible-playbook playbooks/deploy-aocr.yml --syntax-check && ansible-playbook playbooks/apply-db-schema.yml --syntax-check`

## High-Signal Gotchas

- `hooks/` is one codebase for the webhook API, the cron reaper, and the internal blob/import APIs.
- `mirror/` is a separate Go service with a colocated writer-sidecar. Cache warming happens there; hooks only sees the resulting registry notifications.
- `web/` is a public-facing landing site. Most product logic is in `auth/`, `hooks/`, `registry/`, and `db/`.
- `deploy-aocr.yml` reapplies `helm/aocr/files/init.sql` against the live Postgres pod after Helm upgrades because `/docker-entrypoint-initdb.d` only runs on first boot.
- `registry/config.yml` is a template populated by environment variables, not a fully concrete runtime config.
- Plans mention `mirror` and `cluster-snapshot` behavior. Substantial groundwork is already in code via provenance fields, cluster PAT scope logic, mirror cache writes, and the hooks import API.