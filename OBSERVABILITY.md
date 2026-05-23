# Observability

This repository can expose first-class metrics for the registry pull path and the services that support it when metrics are enabled.

Metrics are disabled by default. Turn them on explicitly with:

```yaml
metrics:
  enabled: true
```

## Metrics Matrix

| Service | Endpoint | Port | Status | What You Get |
| :--- | :--- | :--- | :--- | :--- |
| Auth | `/metrics` | `8080` | Implemented | Process metrics, HTTP request count/latency, token validation counts and latency, upstream validation latency, Postgres sync latency, token issuance outcomes, configured PAT count, Postgres pool usage |
| Hooks | `/metrics` | `8000` | Implemented | Process metrics, HTTP request count/latency, webhook authorization counts, registry event counts, events-per-request, Redis cache latency, Postgres sync latency, immediate reap latency, repositories scheduled for reap, last successful webhook timestamp, last successful reap timestamp, Postgres pool usage |
| Registry | `/metrics` | `5001` | Implemented | Native Docker Distribution Prometheus metrics on the debug listener |
| Reaper CronJob | N/A | N/A | Kubernetes-level | Use `kube-state-metrics` for `CronJob` and `Job` health such as successful runs, failed runs, and next schedule time |
| Postgres | N/A | N/A | External exporter required | Use a PostgreSQL exporter if you want query, connection, replication, and storage metrics |
| Redis | N/A | N/A | External exporter required | Use a Redis exporter if you want command latency, memory, keyspace, and client metrics |

## Kubernetes Scrape Setup

When `metrics.enabled=true`, the Helm chart:

- enables native Prometheus metrics in the registry debug listener
- annotates the auth, hooks, and registry pods and services for annotation-based Prometheus scraping
- can optionally create `ServiceMonitor` resources for Prometheus Operator environments
- can optionally create `PrometheusRule` resources for the auth and hooks metrics

To enable `ServiceMonitor` objects:

```yaml
metrics:
  enabled: true
  serviceMonitor:
    enabled: true
```

To enable the built-in alert rules:

```yaml
metrics:
  enabled: true
  prometheusRule:
    enabled: true
```

## Dashboards And Alerts

- Grafana dashboard JSON: [deploy/grafana/aocr-observability-dashboard.json](./deploy/grafana/aocr-observability-dashboard.json)
- Helm alert rules: [helm/aocr/templates/metrics-prometheusrule.yaml](./helm/aocr/templates/metrics-prometheusrule.yaml)

The bundled alert rules focus on the new auth and hooks service metrics:

- auth token issuance error rate
- auth `/v2/token` p95 latency
- auth Postgres pool backpressure
- hooks webhook 5xx rate
- hooks immediate reap errors
- hooks Postgres pool backpressure

## Key Metrics

### Auth

- `aocr_auth_http_requests_total`
- `aocr_auth_http_request_duration_seconds`
- `aocr_auth_token_validation_total`
- `aocr_auth_token_validation_duration_seconds`
- `aocr_auth_upstream_validation_duration_seconds`
- `aocr_auth_database_sync_duration_seconds`
- `aocr_auth_token_issuance_total`
- `aocr_auth_configured_pat_count`
- `aocr_auth_postgres_pool_connections`

### Hooks

- `aocr_hooks_http_requests_total`
- `aocr_hooks_http_request_duration_seconds`
- `aocr_hooks_webhook_authorization_total`
- `aocr_hooks_registry_events_total`
- `aocr_hooks_registry_events_per_request`
- `aocr_hooks_redis_cache_duration_seconds`
- `aocr_hooks_postgres_sync_duration_seconds`
- `aocr_hooks_immediate_reap_duration_seconds`
- `aocr_hooks_repositories_scheduled_for_reap_total`
- `aocr_hooks_last_successful_webhook_timestamp_seconds`
- `aocr_hooks_last_successful_reap_timestamp_seconds`
- `aocr_hooks_postgres_pool_connections`

### Registry

- Native Docker Distribution metrics exposed on the debug listener at `/metrics`

## Local Development

With Docker Compose and `METRICS_ENABLED=true`, the auth and hooks metrics endpoints are:

- `http://localhost:8080/metrics` for auth
- `http://localhost:8000/metrics` for hooks

The registry debug listener is not published to the host by default. To expose `http://localhost:5001/metrics` for the registry as well, start Compose with the metrics override:

```bash
docker compose -f docker-compose.yaml -f docker-compose.metrics.yaml up
```

All of those endpoints only return metrics when `METRICS_ENABLED=true`.