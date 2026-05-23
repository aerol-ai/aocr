# 1000 Concurrent Pulls Review

## Verdict

Not safely as shipped.

The storage choice is directionally correct for scale because the registry stores layers and manifests in S3-compatible object storage instead of local disk, but the request path that authorizes pulls is synchronous, write-heavy, and deployed as single replicas by default. The first likely bottleneck for a burst of 1000 concurrent pulls is the auth path, followed by the single registry and single Postgres instances.

This is an architectural review of the repository as written. I did not find load-test results or capacity numbers in the repo.

## What Is Good Already

- The registry uses S3-compatible object storage, not node-local storage: [registry/config.yml](../../../registry/config.yml).
- The ingress separates `/v2/token` to the auth service and `/v2` to the registry service, which is the right control-plane/data-plane split: [helm/aocr/templates/ingress.yaml](../../../helm/aocr/templates/ingress.yaml).
- The registry and auth services are mostly stateless, so they can be scaled horizontally after the chart and auth path are fixed.

## Blocking Issues

### 1. Every pull token request synchronously calls the upstream auth service

The token endpoint validates the presented credential by calling the external auth-info endpoint on every request before it returns a registry JWT: [auth/src/server.ts#L162](../../../auth/src/server.ts#L162), [auth/src/server.ts#L170](../../../auth/src/server.ts#L170), [auth/src/server.ts#L172](../../../auth/src/server.ts#L172).

Why this is a scale problem:

- A 1000-client pull surge becomes a 1000-request surge against the upstream identity service.
- The timeout is 10 seconds, so slow upstream behavior can pin auth workers for a long time.
- There is no cache, no circuit breaker, and no degraded mode for recently validated tokens.

Expected effect:

- Pulls fail or stall when the upstream validation service slows down, even if S3 and the registry are healthy.

### 2. Every pull token request also performs synchronous Postgres writes

Before issuing the JWT, the auth endpoint opens a Postgres connection and upserts both the user row and the repository row: [auth/src/server.ts#L53](../../../auth/src/server.ts#L53), [auth/src/server.ts#L187](../../../auth/src/server.ts#L187), [auth/src/server.ts#L217](../../../auth/src/server.ts#L217).

Why this is a scale problem:

- Pull authorization is on the critical path for database writes, not just reads.
- Hot repositories will repeatedly contend on the same unique repository key: [db/init.sql#L28](../../../db/init.sql#L28).
- Hot users will repeatedly contend on the same unique external user key: [db/init.sql#L6](../../../db/init.sql#L6).
- The pool is created with default `pg.Pool` settings and no explicit sizing or timeout policy: [auth/src/server.ts#L53](../../../auth/src/server.ts#L53).

Expected effect:

- At high concurrency, token issuance queues behind database connections and row-level contention.
- Postgres write latency directly increases pull latency.

### 3. Auth, registry, and Postgres are all single replicas in the Helm chart

The Helm templates hardcode one replica for auth, registry, and Postgres: [helm/aocr/templates/auth.yaml#L8](../../../helm/aocr/templates/auth.yaml#L8), [helm/aocr/templates/registry.yaml#L8](../../../helm/aocr/templates/registry.yaml#L8), [helm/aocr/templates/postgres.yaml#L9](../../../helm/aocr/templates/postgres.yaml#L9).

Why this is a scale problem:

- There is no horizontal headroom for CPU spikes, network fan-out, or noisy-neighbor effects.
- Any pod restart or node issue becomes a visible outage for pulls.
- A single Postgres instance becomes the control-plane choke point for all token traffic.

Expected effect:

- Even if the code were efficient enough, the shipped deployment defaults do not provide the redundancy or aggregate throughput expected for a 1000-client burst.

### 4. There is no autoscaling, resource budgeting, or resiliency policy in the hot path

I did not find HPA manifests, pod disruption budgets, or resource requests/limits for the auth and registry deployments in the chart: [helm/aocr/templates/auth.yaml](../../../helm/aocr/templates/auth.yaml), [helm/aocr/templates/registry.yaml](../../../helm/aocr/templates/registry.yaml), [helm/aocr/values.yaml](../../../helm/aocr/values.yaml).

Why this is a scale problem:

- Kubernetes has no target to scale on when pull traffic spikes.
- Without resource requests/limits, scheduling and throttling behavior are unpredictable under load.
- Without PDBs or probes, maintenance and failure recovery are weaker than they need to be for a registry.

Expected effect:

- Throughput and availability depend too heavily on cluster luck and manual intervention.

### 5. The registry path has no explicit cache/CDN/offload configuration in this repo

The ingress sends all `/v2` traffic to the registry service and the repo does not define any cache tier, CDN layer, or explicit download offload configuration: [helm/aocr/templates/ingress.yaml#L29](../../../helm/aocr/templates/ingress.yaml#L29), [helm/aocr/templates/ingress.yaml#L36](../../../helm/aocr/templates/ingress.yaml#L36), [registry/config.yml](../../../registry/config.yml).

Why this is a scale problem:

- 1000 concurrent pulls can create large fan-out on manifest and blob reads.
- Without an explicit edge-cache strategy in the repo, you cannot assume repeated pulls of the same large image will be absorbed anywhere other than the registry tier and object store.

Expected effect:

- The data plane may still work if the object store and network are heavily provisioned, but the repository does not currently encode a scale strategy for it.

### 6. Observability needed to be added before 1000-concurrent-pull behavior could be proven safely

Current branch status:

- Registry Prometheus metrics are now enabled on the debug listener at [registry/config.yml#L24](../../../registry/config.yml#L24) and [registry/config.yml#L25](../../../registry/config.yml#L25).
- The auth service now exposes `/metrics` with request, validation, upstream, DB-sync, token issuance, PAT-count, and Postgres pool metrics.
- The hooks service now exposes `/metrics` with request, webhook, Redis, Postgres sync, and immediate reap metrics.
- Helm now annotates scrape targets and can optionally create `ServiceMonitor` resources.

Remaining gap:

- You still need a Prometheus-compatible scraper in-cluster.
- Postgres, Redis, and CronJob-level reaper health still require external exporters or kube-state-metrics for full infrastructure visibility.

## Bottom Line

The current repository is not ready to claim support for 1000 concurrent pulls.

The architecture can get there, but only after the API-backed auth path is removed from the synchronous upstream-and-database critical path and the deployment is made horizontally scalable.

Current status:

- The PAT-backed auth path now validates locally, supports multiple configured PATs, and skips auth-time Postgres sync.
- The API-backed auth path still performs synchronous upstream validation and Postgres writes.

## Minimum Changes Before Claiming 1000 Concurrent Pulls

1. Make pull token issuance cheap.
   - Keep PAT-backed traffic on the local fast-path.
   - Cache or otherwise cheapen API-backed validation results for a short TTL.
   - Stop writing `users` and `repositories` on every API-backed pull token request.
   - Move API-backed metadata sync off the pull critical path or make it best-effort async.

2. Add scale controls to the Helm chart.
   - Configurable replica counts for auth and registry.
   - HPAs for auth and registry.
   - Resource requests/limits, readiness probes, liveness probes, and PDBs.

3. Treat Postgres as a production dependency.
   - Use a production-grade external Postgres deployment or operator.
   - Size connection pools explicitly and add connection timeout limits.

4. Add observability and run an actual pull benchmark.
   - Keep registry, auth, and hooks metrics scraped in-cluster.
   - Add Postgres, Redis, and CronJob exporters if you need full infrastructure visibility.
   - Run a controlled 1000-client pull test and record p50/p95/p99 latency and error rate.