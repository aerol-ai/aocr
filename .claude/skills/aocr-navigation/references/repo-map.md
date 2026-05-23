# AOCR Repo Map

## Read These First

- `ARCH.md`: best architecture and directory summary
- `README.md`: product surface and hosted usage
- `SELF_HOSTING.md`: install and secret model
- `RETENTION.md`: retention contract
- `OBSERVABILITY.md`: metrics and dashboards
- `understanding.md`: short lifecycle walkthrough

## High-Signal Directories

| Path | What Lives Here | Open First |
| --- | --- | --- |
| `auth/` | Token validation, JWT issuance, PAT paths, cluster PAT scope logic | `auth/src/server.ts` |
| `hooks/` | Webhook ingestion, retention parsing, reaper selection, registry deletes | `hooks/src/controllers/HookAPI.ts`, `hooks/src/util/imageRetention.ts` |
| `web/` | Public landing page and docs UI | `web/src/app/page.tsx` |
| `registry/` | Docker Distribution config and runtime shell wrappers | `registry/config.yml` |
| `db/` | Bootstrap schema and migrations | `db/init.sql` |
| `helm/aocr/` | Kubernetes chart values, templates, and embedded SQL | `helm/aocr/values.yaml` |
| `ansible/` | Helm deployment automation and secret generation helpers | `ansible/playbooks/deploy-aocr.yml` |
| `.github/workflows/` | Image and chart publishing | `.github/workflows/deploy.yml` |

## Route By Question

- Login, JWT, account mismatch, PAT fallback: `auth/src/server.ts`
- Cluster namespace access: `auth/src/clusterPat.ts`
- Push webhook handling: `hooks/src/controllers/HookAPI.ts`
- Retention suffix parsing: `hooks/src/util/tagRetention.ts`
- Why a tag was deleted: `hooks/src/util/imageRetention.ts`
- Metrics definitions: `auth/src/metrics.ts`, `hooks/src/metrics.ts`
- Registry behavior and webhooks: `registry/config.yml`
- Schema and retention columns: `db/init.sql`
- Local stack wiring: `docker-compose.yaml`
- Helm deployment wiring: `helm/aocr/values.yaml`, `helm/aocr/templates/`

## Source Of Truth

- Edit `auth/src/**`, not `auth/dist-test/**`.
- Edit `hooks/src/**` and `hooks/test/**`, not `hooks/build/**` or `hooks/build-test/**`.
- Keep `db/init.sql` and `helm/aocr/files/init.sql` aligned on schema changes.
- Treat `plans/**` as design intent unless the implementation matches.