import type { Pool } from 'pg';

export interface ImageListRow {
  repository: string;
  tag: string;
  manifest_digest: string | null;
  provenance: string | null;
  upstream_ref: string | null;
  cluster_id: string | null;
  source_sandbox_id: string | null;
  retention_mode: string | null;
  retention_value_seconds: number | null;
  raw_retention_suffix: string | null;
  last_pushed_at: string | null;
  last_pulled_at: string | null;
  expires_at: string | null;
}

export const MIN_LIMIT = 1;
export const MAX_LIMIT = 1000;
export const DEFAULT_LIMIT = 100;

const SELECT_PROJECTION = `
SELECT
  r.organization || '/' || r.name AS repository,
  i.tag,
  i.manifest_digest,
  i.provenance,
  i.upstream_ref,
  i.cluster_id,
  i.source_sandbox_id,
  i.retention_mode,
  i.retention_value_seconds,
  i.raw_retention_suffix,
  i.last_pushed_at,
  i.last_pulled_at,
  CASE i.retention_mode
    WHEN 'ttl'  THEN i.expires_at
    WHEN 'idle' THEN COALESCE(i.last_pulled_at, i.last_pushed_at)
                      + (i.retention_value_seconds || ' seconds')::interval
    ELSE NULL
  END AS expires_at
FROM images i
JOIN repositories r ON r.id = i.repository_id`.trim();

const ORDER_AND_PAGE = `ORDER BY i.last_pushed_at DESC NULLS LAST
LIMIT $LIMIT OFFSET $OFFSET`;

export interface ImageListPage {
  rows: ImageListRow[];
  hasMore: boolean;
}

// Builders pass through limit/offset verbatim. Callers are expected to sanitize
// via parseLimit/parseOffset at the HTTP boundary.
export function buildAdminListQuery(limit: number, offset: number): { text: string; values: unknown[] } {
  const text = `${SELECT_PROJECTION}
${ORDER_AND_PAGE.replace('$LIMIT', '$1').replace('$OFFSET', '$2')}`;
  return { text, values: [limit, offset] };
}

export function buildUserListQuery(externalId: string, limit: number, offset: number): { text: string; values: unknown[] } {
  const text = `${SELECT_PROJECTION}
JOIN users u ON u.id = r.user_id
WHERE u.external_id = $1
${ORDER_AND_PAGE.replace('$LIMIT', '$2').replace('$OFFSET', '$3')}`;
  return { text, values: [externalId, limit, offset] };
}

// Ask Postgres for one row past the page boundary so we can report has_more
// without an O(N) COUNT(*).
function trimOverflow(rows: ImageListRow[], limit: number): ImageListPage {
  if (rows.length > limit) {
    return { rows: rows.slice(0, limit), hasMore: true };
  }
  return { rows, hasMore: false };
}

export async function listAllImages(pool: Pool, limit: number, offset: number): Promise<ImageListPage> {
  const { text, values } = buildAdminListQuery(limit + 1, offset);
  const result = await pool.query(text, values);
  return trimOverflow(result.rows as ImageListRow[], limit);
}

export async function listImagesForExternalId(
  pool: Pool,
  externalId: string,
  limit: number,
  offset: number,
): Promise<ImageListPage> {
  const { text, values } = buildUserListQuery(externalId, limit + 1, offset);
  const result = await pool.query(text, values);
  return trimOverflow(result.rows as ImageListRow[], limit);
}

export function clampLimit(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_LIMIT;
  return Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, Math.floor(raw)));
}

export function clampOffset(raw: number): number {
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return Math.floor(raw);
}

export function parseLimit(raw: unknown): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return clampLimit(n);
}

export function parseOffset(raw: unknown): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return clampOffset(n);
}
