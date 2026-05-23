# AOCR Agent Guide

## Read First

- `ARCH.md` is the fastest way to rebuild the runtime model of this repo.
- `README.md` explains the product surface and hosted usage.
- `SELF_HOSTING.md` explains operator setup and install-time secrets.
- `RETENTION.md` is the contract for tag cleanup semantics.
- `OBSERVABILITY.md` covers metrics, dashboards, and scrape wiring.
- `understanding.md` is the shortest push and reap lifecycle walkthrough.
- `plans/` contains design docs and future work. Treat plans as intent, not live behavior, unless the code matches.

## Monorepo Map

| Path | Purpose | Start Here |
| --- | --- | --- |
| `auth/` | Docker token auth service. Validates upstream tokens, static PATs, and cluster PATs, then signs `/v2/token` JWTs. | `auth/src/server.ts` |
| `hooks/` | Shared codebase for the webhook API and the scheduled reaper. | `hooks/src/controllers/HookAPI.ts`, `hooks/src/util/imageRetention.ts` |
| `web/` | Next.js marketing and documentation site, not an admin console. | `web/src/app/page.tsx`, `web/src/components/` |
| `registry/` | Docker Distribution config template and container wrapper scripts. | `registry/config.yml` |
| `db/` | Bootstrap schema and manual migrations. | `db/init.sql` |
| `helm/aocr/` | Kubernetes deployment chart, including embedded SQL and service templates. | `helm/aocr/values.yaml` |
| `ansible/` | Helm deployment wrapper for VM-backed operations. | `ansible/playbooks/deploy-aocr.yml` |
| `deploy/grafana/` | Importable Grafana dashboard JSON. | `deploy/grafana/aocr-observability-dashboard.json` |
| `docker-compose*.yaml` | Local stack plus metrics and GC overrides. | `docker-compose.yaml` |
| `.github/workflows/` | CI publishing for container images and the Helm chart. | `.github/workflows/deploy.yml` |

## Route By Task

- Docker login, bearer token issuance, scope bugs: `auth/src/server.ts`.
- Cluster PAT parsing and namespace restrictions: `auth/src/clusterPat.ts`.
- Auth metrics: `auth/src/metrics.ts`.
- Registry webhook ingestion for push and pull events: `hooks/src/controllers/HookAPI.ts`.
- Retention suffix parsing and provenance inference: `hooks/src/util/tagRetention.ts`.
- Reaper selection logic and registry manifest deletion: `hooks/src/util/imageRetention.ts`.
- Hook server wiring and CLI entrypoints: `hooks/src/server/server.ts`, `hooks/src/commands/hooks.ts`, `hooks/src/commands/reap.ts`.
- Database columns and retention schema: `db/init.sql`.
- Registry notification and token auth configuration: `registry/config.yml`.
- Helm deployment wiring: `helm/aocr/values.yaml` and `helm/aocr/templates/`.
- Local development topology: `docker-compose.yaml`, `docker-compose.metrics.yaml`, `docker-compose.gc.yaml`.
- Publish pipeline: `.github/workflows/deploy.yml`.

## Source Of Truth

- Edit `auth/src/**`, not `auth/dist-test/**`.
- Edit `hooks/src/**` and `hooks/test/**`, not `hooks/build/**` or `hooks/build-test/**`.
- The schema bootstrap lives in `db/init.sql`. Keep `helm/aocr/files/init.sql` in sync when schema changes.
- The web source of truth is `web/src/**`; the app is mostly static sections under `web/src/components/`.

## Useful Existing Docs

- Hosted usage and product framing: `README.md`
- Self-hosting: `SELF_HOSTING.md`
- Retention semantics and GC caveat: `RETENTION.md`
- Metrics and dashboards: `OBSERVABILITY.md`
- Runtime lifecycle walkthrough: `understanding.md`
- Longer narrative architecture writeup: `aocr_architecture_blog.md`

## Repo Skills

- `.claude/skills/aocr-navigation/`: repo map and first-file routing for most tasks.
- `.claude/skills/aocr-retention/`: retention, provenance, webhook, and reaper tracing.
- `.claude/skills/aocr-operations/`: Compose, Helm, Ansible, metrics, GC, and CI routing.

## Validation Commands

- Auth: `cd auth && corepack enable && pnpm install --frozen-lockfile && pnpm test`
- Hooks: `cd hooks && npm install && npx tsc -p tsconfig.json && npm test`
- Web: `cd web && npm install && npm run lint && npm run build`
- Helm: `helm lint helm/aocr`
- Ansible syntax: `cd ansible && ansible-playbook playbooks/deploy-aocr.yml --syntax-check`

## High-Signal Gotchas

- `hooks/` is one codebase for two processes: the webhook API and the cron reaper.
- `web/` is a public-facing landing site. Most product logic is in `auth/`, `hooks/`, `registry/`, and `db/`.
- `registry/config.yml` is a template populated by environment variables, not a fully concrete runtime config.
- Plans mention `mirror` and `cluster-snapshot` behavior. Some groundwork is already in code via provenance fields and cluster PAT scope logic.