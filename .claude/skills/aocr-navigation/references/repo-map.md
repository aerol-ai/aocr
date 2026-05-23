# AOCR Repo Map

## Read These First

- `ARCH.md`: best architecture and directory summary
- `README.md`: product surface, hosted usage, and `/v1/images`
- `SELF_HOSTING.md`: install and secret model
- `MIRROR.md`: mirror architecture, routes, and operator checks
- `RETENTION.md`: retention contract
- `OBSERVABILITY.md`: metrics and dashboards
- `ansible/README.md`: deployment and schema-upgrade flow
- `aocr_aerol_stitch.md`: AOCR to AerolVM integration path
- `understanding.md`: short lifecycle walkthrough

## High-Signal Directories

| Path | What Lives Here | Open First |
| --- | --- | --- |
| `auth/` | Token validation, JWT issuance, PAT paths, cluster PAT scope logic, and `/v1/images` | `auth/src/server.ts`, `auth/src/imageList.ts` |
| `hooks/` | Webhook ingestion, retention parsing, reaper selection, registry deletes, blob presence, and imports | `hooks/src/controllers/HookAPI.ts`, `hooks/src/controllers/ImportAPI.ts`, `hooks/src/util/imageRetention.ts` |
| `mirror/` | Pull-through proxy, upstream routing, cache warming, and writer uploads | `mirror/proxy.go`, `mirror/router.go`, `mirror/upstream.go` |
| `web/` | Public landing page and docs UI | `web/src/app/page.tsx` |
| `registry/` | Docker Distribution config and runtime shell wrappers | `registry/config.yml` |
| `db/` | Bootstrap schema and migrations | `db/init.sql` |
| `helm/aocr/` | Kubernetes chart values, templates, and embedded SQL | `helm/aocr/values.yaml` |
| `ansible/` | Helm deployment automation, secret generation, and schema catch-up | `ansible/playbooks/deploy-aocr.yml`, `ansible/playbooks/apply-db-schema.yml` |
| `.github/workflows/` | Auth/hooks/reaper/registry/web/mirror image builds and chart publishing | `.github/workflows/deploy.yml` |

## Route By Question

- Login, JWT, account mismatch, PAT fallback: `auth/src/server.ts`
- `/v1/images` scope, paging, and SQL shape: `auth/src/server.ts`, `auth/src/imageList.ts`
- Cluster namespace access: `auth/src/clusterPat.ts`
- Push webhook handling: `hooks/src/controllers/HookAPI.ts`
- Internal blob presence or import behavior: `hooks/src/controllers/InternalAPI.ts`, `hooks/src/controllers/ImportAPI.ts`, `hooks/src/util/mountFromRepo.ts`
- Retention suffix parsing: `hooks/src/util/tagRetention.ts`
- Why a tag was deleted: `hooks/src/util/imageRetention.ts`
- Why a mirror pull did or did not land in AOCR metadata: `mirror/proxy.go`, `mirror/writer.go`, `hooks/src/controllers/HookAPI.ts`
- Mirror path routing and upstream selection: `mirror/router.go`, `mirror/upstream.go`
- Metrics definitions: `auth/src/metrics.ts`, `hooks/src/metrics.ts`
- Registry behavior and webhooks: `registry/config.yml`
- Schema and retention columns: `db/init.sql`
- Local stack wiring: `docker-compose.yaml`
- Helm deployment wiring: `helm/aocr/values.yaml`, `helm/aocr/templates/`
- Live schema sync and operator flow: `ansible/playbooks/deploy-aocr.yml`, `ansible/playbooks/apply-db-schema.yml`, `ansible/README.md`

## Source Of Truth

- Edit `auth/src/**`, not `auth/dist-test/**`.
- Edit `hooks/src/**` and `hooks/test/**`, not `hooks/build/**` or `hooks/build-test/**`.
- Edit `mirror/*.go` and `mirror/*_test.go` for mirror behavior.
- Keep `db/init.sql` and `helm/aocr/files/init.sql` aligned on schema changes.
- Treat `plans/**` as design intent unless the implementation matches.