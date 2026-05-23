import type express from 'express';
import type { Pool } from 'pg';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

const metricsRegistry = new Registry();
collectDefaultMetrics({
  prefix: 'aocr_auth_',
  register: metricsRegistry,
});

let boundPool: Pool | null = null;

const httpRequestsTotal = new Counter({
  name: 'aocr_auth_http_requests_total',
  help: 'Total number of HTTP requests handled by the auth service.',
  labelNames: ['method', 'route', 'status_code'],
  registers: [metricsRegistry],
});

const httpRequestDurationSeconds = new Histogram({
  name: 'aocr_auth_http_request_duration_seconds',
  help: 'HTTP request latency for the auth service.',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [metricsRegistry],
});

const tokenValidationTotal = new Counter({
  name: 'aocr_auth_token_validation_total',
  help: 'Token validation attempts by strategy and outcome.',
  labelNames: ['strategy', 'outcome'],
  registers: [metricsRegistry],
});

const tokenValidationDurationSeconds = new Histogram({
  name: 'aocr_auth_token_validation_duration_seconds',
  help: 'Token validation latency by strategy and outcome.',
  labelNames: ['strategy', 'outcome'],
  buckets: [0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [metricsRegistry],
});

const upstreamValidationDurationSeconds = new Histogram({
  name: 'aocr_auth_upstream_validation_duration_seconds',
  help: 'Latency of the upstream validation API.',
  labelNames: ['outcome'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [metricsRegistry],
});

const databaseSyncDurationSeconds = new Histogram({
  name: 'aocr_auth_database_sync_duration_seconds',
  help: 'Latency of auth metadata sync to Postgres.',
  labelNames: ['outcome'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [metricsRegistry],
});

const tokenIssuanceTotal = new Counter({
  name: 'aocr_auth_token_issuance_total',
  help: 'Registry token issuance results by validation strategy.',
  labelNames: ['strategy', 'outcome'],
  registers: [metricsRegistry],
});

const configuredPatCount = new Gauge({
  name: 'aocr_auth_configured_pat_count',
  help: 'Number of configured static PATs available to the auth service.',
  registers: [metricsRegistry],
});

const postgresPoolConnections = new Gauge({
  name: 'aocr_auth_postgres_pool_connections',
  help: 'Postgres pool connection counts by state.',
  labelNames: ['state'],
  registers: [metricsRegistry],
  collect() {
    if (!boundPool) {
      return;
    }

    this.set({ state: 'total' }, boundPool.totalCount);
    this.set({ state: 'idle' }, boundPool.idleCount);
    this.set({ state: 'waiting' }, boundPool.waitingCount);
  },
});

function resolveRouteLabel(req: express.Request): string {
  const routePath = req.route?.path;
  if (typeof routePath === 'string') {
    return `${req.baseUrl || ''}${routePath}`;
  }

  return req.path || req.originalUrl || 'unknown';
}

export function bindMetricsPool(pool: Pool): void {
  boundPool = pool;
}

export function setConfiguredPatCount(count: number): void {
  configuredPatCount.set(count);
}

export function elapsedSecondsSince(startNs: bigint): number {
  return Number(process.hrtime.bigint() - startNs) / 1_000_000_000;
}

export function recordTokenValidation(strategy: 'api' | 'pat', outcome: string, durationSeconds: number): void {
  tokenValidationTotal.inc({ strategy, outcome });
  tokenValidationDurationSeconds.observe({ strategy, outcome }, durationSeconds);
}

export function recordUpstreamValidation(outcome: string, durationSeconds: number): void {
  upstreamValidationDurationSeconds.observe({ outcome }, durationSeconds);
}

export function recordDatabaseSync(outcome: string, durationSeconds: number): void {
  databaseSyncDurationSeconds.observe({ outcome }, durationSeconds);
}

export function recordTokenIssuance(strategy: 'api' | 'pat' | 'unknown', outcome: string): void {
  tokenIssuanceTotal.inc({ strategy, outcome });
}

export function mountMetrics(app: express.Application): void {
  app.use((req, res, next) => {
    if (req.path === '/metrics') {
      next();
      return;
    }

    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
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

  app.get('/metrics', async (_req, res) => {
    res.set('Content-Type', metricsRegistry.contentType);
    res.end(await metricsRegistry.metrics());
  });
}

void postgresPoolConnections;