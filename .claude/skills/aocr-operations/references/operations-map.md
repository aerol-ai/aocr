# AOCR Operations Map

## Deployment Surfaces

| Surface | Files | Use For |
| --- | --- | --- |
| Local full stack | `docker-compose.yaml` | Running all services locally |
| Local registry metrics | `docker-compose.metrics.yaml` | Publishing registry debug metrics on host port 5001 |
| Local garbage collection | `docker-compose.gc.yaml` | Running registry GC in development |
| Kubernetes defaults | `helm/aocr/values.yaml` | Main install-time config surface |
| Kubernetes manifests | `helm/aocr/templates/` | Service, secret, ingress, metrics, and GC resources |
| Embedded schema copy | `helm/aocr/files/init.sql` | Bootstrap schema used by Helm installs |
| Registry runtime config | `registry/config.yml` | Token auth, webhooks, S3, metrics, debug listener |
| VM automation | `ansible/playbooks/deploy-aocr.yml` | Helm deployment with secret generation and file sync |
| Publish pipeline | `.github/workflows/deploy.yml` | GHCR image publishing and Helm OCI packaging |

## Observability

- Metrics docs: `OBSERVABILITY.md`
- Grafana dashboard: `deploy/grafana/aocr-observability-dashboard.json`
- Auth metrics code: `auth/src/metrics.ts`
- Hooks metrics code: `hooks/src/metrics.ts`
- Helm metrics resources: `helm/aocr/templates/metrics-servicemonitors.yaml`, `helm/aocr/templates/metrics-prometheusrule.yaml`

## Storage And GC

- Registry deletion only removes manifests; blobs remain until garbage collection.
- User-facing GC explanation lives in `RETENTION.md`.
- Registry GC scripts live in `registry/garbage-collect.sh` and the Helm `registryGc` resources.
- Local GC entrypoint is `docker-compose.gc.yaml`.

## Keep In Sync

- Schema changes: `db/init.sql` and `helm/aocr/files/init.sql`
- Metrics behavior changes: code in `auth/src/metrics.ts` or `hooks/src/metrics.ts`, plus docs in `OBSERVABILITY.md` and possibly Helm templates
- Registry auth or webhook changes: `registry/config.yml`, matching env wiring in Compose and Helm