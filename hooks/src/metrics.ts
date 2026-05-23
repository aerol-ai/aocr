import * as express from "express";
import { Pool } from "pg";
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";

function parseBoolean(value?: string): boolean {
  return ["1", "true", "yes", "on"].includes((value || "").trim().toLowerCase());
}

const metricsEnabled = parseBoolean(process.env.METRICS_ENABLED || "false");

const metricsRegistry = new Registry();
if (metricsEnabled) {
  collectDefaultMetrics({
    prefix: "aocr_hooks_",
    register: metricsRegistry,
  });
}

let boundPool: Pool | null = null;

const httpRequestsTotal = new Counter({
  name: "aocr_hooks_http_requests_total",
  help: "Total number of HTTP requests handled by the hooks service.",
  labelNames: ["method", "route", "status_code"],
  registers: [metricsRegistry],
});

const httpRequestDurationSeconds = new Histogram({
  name: "aocr_hooks_http_request_duration_seconds",
  help: "HTTP request latency for the hooks service.",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [metricsRegistry],
});

const webhookAuthorizationTotal = new Counter({
  name: "aocr_hooks_webhook_authorization_total",
  help: "Webhook authorization outcomes.",
  labelNames: ["outcome"],
  registers: [metricsRegistry],
});

const registryEventsTotal = new Counter({
  name: "aocr_hooks_registry_events_total",
  help: "Registry events observed by action.",
  labelNames: ["action"],
  registers: [metricsRegistry],
});

const registryEventsPerRequest = new Histogram({
  name: "aocr_hooks_registry_events_per_request",
  help: "Number of registry events included in each webhook request.",
  buckets: [0, 1, 2, 5, 10, 20, 50, 100],
  registers: [metricsRegistry],
});

const redisCacheDurationSeconds = new Histogram({
  name: "aocr_hooks_redis_cache_duration_seconds",
  help: "Latency of legacy Redis cache writes for pushed images.",
  labelNames: ["outcome"],
  buckets: [0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [metricsRegistry],
});

const postgresSyncDurationSeconds = new Histogram({
  name: "aocr_hooks_postgres_sync_duration_seconds",
  help: "Latency of Postgres metadata sync during registry webhook handling.",
  labelNames: ["outcome"],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [metricsRegistry],
});

const immediateReapDurationSeconds = new Histogram({
  name: "aocr_hooks_immediate_reap_duration_seconds",
  help: "Latency of immediate repository reaping triggered by push webhooks.",
  labelNames: ["outcome"],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [metricsRegistry],
});

const repositoriesScheduledForReap = new Counter({
  name: "aocr_hooks_repositories_scheduled_for_reap_total",
  help: "Total repositories queued for immediate reaping from webhook handling.",
  registers: [metricsRegistry],
});

const lastSuccessfulWebhookTimestampSeconds = new Gauge({
  name: "aocr_hooks_last_successful_webhook_timestamp_seconds",
  help: "Unix timestamp of the last successful registry webhook request.",
  registers: [metricsRegistry],
});

const lastSuccessfulReapTimestampSeconds = new Gauge({
  name: "aocr_hooks_last_successful_reap_timestamp_seconds",
  help: "Unix timestamp of the last successful immediate reap triggered by the hooks service.",
  registers: [metricsRegistry],
});

const postgresPoolConnections = new Gauge({
  name: "aocr_hooks_postgres_pool_connections",
  help: "Hooks Postgres pool connection counts by state.",
  labelNames: ["state"],
  registers: [metricsRegistry],
  collect() {
    if (boundPool == null) {
      return;
    }

    this.set({ state: "total" }, boundPool.totalCount);
    this.set({ state: "idle" }, boundPool.idleCount);
    this.set({ state: "waiting" }, boundPool.waitingCount);
  },
});

function resolveRouteLabel(req: express.Request): string {
  const routePath = req.route && req.route.path;
  if (typeof routePath === "string") {
    return `${req.baseUrl || ""}${routePath}`;
  }

  return req.path || req.originalUrl || "unknown";
}

export function bindMetricsPool(pool: Pool): void {
  if (!metricsEnabled) {
    return;
  }

  boundPool = pool;
}

export function elapsedSecondsSince(startNs: bigint): number {
  return Number(process.hrtime.bigint() - startNs) / 1_000_000_000;
}

export function recordWebhookAuthorization(outcome: "accepted" | "rejected"): void {
  if (!metricsEnabled) {
    return;
  }

  webhookAuthorizationTotal.inc({ outcome });
}

export function recordRegistryEvent(action: string): void {
  if (!metricsEnabled) {
    return;
  }

  registryEventsTotal.inc({ action: action || "unknown" });
}

export function recordRegistryEventBatch(count: number): void {
  if (!metricsEnabled) {
    return;
  }

  registryEventsPerRequest.observe(count);
}

export function recordRedisCache(outcome: string, durationSeconds: number): void {
  if (!metricsEnabled) {
    return;
  }

  redisCacheDurationSeconds.observe({ outcome }, durationSeconds);
}

export function recordPostgresSync(outcome: string, durationSeconds: number): void {
  if (!metricsEnabled) {
    return;
  }

  postgresSyncDurationSeconds.observe({ outcome }, durationSeconds);
}

export function recordImmediateReap(outcome: string, durationSeconds: number): void {
  if (!metricsEnabled) {
    return;
  }

  immediateReapDurationSeconds.observe({ outcome }, durationSeconds);
}

export function recordRepositoriesScheduledForReap(count: number): void {
  if (!metricsEnabled) {
    return;
  }

  repositoriesScheduledForReap.inc(count);
}

export function markSuccessfulWebhook(): void {
  if (!metricsEnabled) {
    return;
  }

  lastSuccessfulWebhookTimestampSeconds.set(Date.now() / 1000);
}

export function markSuccessfulReap(): void {
  if (!metricsEnabled) {
    return;
  }

  lastSuccessfulReapTimestampSeconds.set(Date.now() / 1000);
}

export function mountMetrics(app: { use: Function; get: Function }): void {
  if (!metricsEnabled) {
    return;
  }

  app.use((req, res, next) => {
    if (req.path === "/metrics") {
      next();
      return;
    }

    const startedAt = process.hrtime.bigint();
    res.on("finish", () => {
      const labels = {
        method: req.method,
        route: resolveRouteLabel(req),
        status_code: String(res.statusCode),
      };
      const durationSeconds = elapsedSecondsSince(startedAt);

      httpRequestsTotal.inc(labels);
      httpRequestDurationSeconds.observe(labels, durationSeconds);
    });

    next();
  });

  app.get("/metrics", async (_req, res) => {
    res.set("Content-Type", metricsRegistry.contentType);
    res.end(await metricsRegistry.metrics());
  });
}

void postgresPoolConnections;